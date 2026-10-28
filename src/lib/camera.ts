/**
 * 西田カメラ（PromptCam, ~/Dev/promptcam）の窓口: アプリ → この B-guru → tailnet → dk5090 の加工サーバー。
 * Tailscale を入れていない人の iPhone からも使えるようにするためのもの（設計: promptcam/docs/no-tailscale-design.html）。
 *
 * - 使える人: B-guru の有料会員と、管理者が招待したアドレス（会員でない人。オーナー決定 2026-10-27）。
 * - ログイン: メールの 6 桁コード。B-guru のログイン（login_requests・agent_tokens）とは表もトークンも別。
 *   カメラの鍵では B-guru のほかの API は一切使えない（招待した人は会員ではないので、混ぜない）。
 * - 自由文のプロンプトは CAMERA_FREE_TEXT のアドレスだけ（未設定ならオーナーだけ）。ほかの人は内蔵の 5 つだけ
 *   （自由文と人の写真で性的な加工ができてしまうため。モデルにフィルタはない）。
 * - 回数: 1 人（メールアドレス）1 時間 30 回・1 日 100 回、全員合わせて 1 時間 300 回、1 人同時 1 件。
 * - 記録: 誰が・いつ・どのプリセット・自由文の本文（自由文のときだけ）・結果を 30 日。写真と結果の画像は残さない。
 * - dk5090 へは HMAC の署名つきで送る（dk5090 側は tailnet のタグと署名の両方を見る）。
 */
import crypto from "crypto";
import sharp from "sharp";
import { pool } from "./db";
import { isAdmin } from "./admin";
import { featureOnForAnyone, featureEnabledFor } from "./feature-flag";
import { findMemberByEmail, GhostUnavailableError, isPaidMember } from "./ghost";
import { hitLimit } from "./login";
import { sendEmail } from "./mailgun";
import { relayHttp, type RelayResponse } from "./camera-relay";

export const CAMERA_CODE_TTL_MIN = 10;
export const CAMERA_MAX_CODE_ATTEMPTS = 5;
/** 最後に使ってからこの日数まで鍵が有効。 */
export const CAMERA_TOKEN_SLIDING_DAYS = 90;
export const CAMERA_MAX_TOKENS_PER_EMAIL = 5;
/** 会員かどうかを確かめ直す間隔と、Ghost に届かないときに通す猶予（agent-auth と同じ考え方）。 */
export const CAMERA_RECHECK_HOURS = 6;
export const CAMERA_GRACE_HOURS = 24;
export const CAMERA_LOG_DAYS = 30;
export const CAMERA_MAX_PROMPT = 1000;
/** アプリが送る写真（base64 の JSON 全体）の上限。アプリは約 2.4MP の JPEG にしてから送る（0.2.0 までは長辺 1536）。 */
export const CAMERA_MAX_BODY = 12 * 1024 * 1024;

export const CAMERA_LIMITS = {
  mailPerEmail: { limit: 5, window: "1 hour" },
  mailPerIp: { limit: 20, window: "1 hour" },
  failPerIp: { limit: 30, window: "1 hour" },
  editPerHour: { limit: 30, window: "1 hour" },
  editPerDay: { limit: 100, window: "1 day" },
  editAllPerHour: { limit: 300, window: "1 hour" },
} as const;

/** アプリに内蔵のプリセット（ios/PromptCam/Presets.swift と dk5090 の PRESETS と同じ id）。 */
export const CAMERA_PRESET_IDS = ["mojigraph-1", "mojigraph-2", "mojigraph-3", "cover-rgb", "mandala", "mimeikei"] as const;

export const CAMERA_FREE_TEXT_FLAG = "CAMERA_FREE_TEXT";
const OWNER_EMAIL = "drikin@gmail.com";

export type CameraKind = "member" | "guest";

export class CameraError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const TOO_MANY = "試行回数が多すぎます。しばらくしてからもう一度お試しください";

function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** 自由文を使えるか。CAMERA_FREE_TEXT（メールのカンマ区切り）、未設定ならオーナーだけ。 */
export function cameraFreeTextFor(email: string): boolean {
  if (featureOnForAnyone(CAMERA_FREE_TEXT_FLAG)) return featureEnabledFor(CAMERA_FREE_TEXT_FLAG, email);
  return email === OWNER_EMAIL;
}

// ---------------------------------------------------------------- 招待

export interface CameraInvite {
  email: string;
  invitedBy: string;
  note: string;
  createdAt: string;
}

async function inviteActive(email: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM camera_invites WHERE email = $1 AND revoked_at IS NULL`, [email]);
  return !!r.rows[0];
}

export async function listInvites(): Promise<CameraInvite[]> {
  const r = await pool.query(
    `SELECT email, invited_by, note, created_at FROM camera_invites WHERE revoked_at IS NULL ORDER BY created_at DESC`
  );
  return r.rows.map((x) => ({
    email: x.email,
    invitedBy: x.invited_by,
    note: x.note ?? "",
    createdAt: new Date(x.created_at).toISOString(),
  }));
}

export async function addInvite(email: string, by: string, note: string): Promise<void> {
  if (!isValidEmail(email)) throw new CameraError(400, "invalid_request", "メールアドレスが不正です");
  await pool.query(
    `INSERT INTO camera_invites (email, invited_by, note) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET invited_by = $2, note = $3, created_at = now(), revoked_at = NULL`,
    [email, by, note.slice(0, 200)]
  );
}

/** 招待を取り消す。その人の招待で出した鍵もすぐ使えなくする（会員としての鍵は残す）。 */
export async function revokeInvite(email: string): Promise<void> {
  await pool.query(`UPDATE camera_invites SET revoked_at = now() WHERE email = $1 AND revoked_at IS NULL`, [email]);
  await pool.query(
    `UPDATE camera_tokens SET revoked_at = now() WHERE email = $1 AND kind = 'guest' AND revoked_at IS NULL`,
    [email]
  );
}

// ---------------------------------------------------------------- 使える人か

/**
 * 会員なら member、招待されていれば guest、どちらでもなければ null。
 * Ghost に届かないときは GhostUnavailableError（呼び出し側が決める）。招待されている人は Ghost を見ずに guest。
 */
export async function cameraEligibility(email: string): Promise<CameraKind | null> {
  let ghostError: unknown = null;
  try {
    const m = await findMemberByEmail(email);
    if (m && isPaidMember(m)) return "member";
  } catch (e) {
    ghostError = e;
  }
  if (await inviteActive(email)) return "guest";
  if (ghostError) throw ghostError;
  return null;
}

// ---------------------------------------------------------------- ログイン

function loginMail(code: string) {
  const text = [
    "西田カメラへのログインです。",
    "",
    `アプリのログイン画面にこのコードを入力してください: ${code}`,
    "",
    `コードは ${CAMERA_CODE_TTL_MIN} 分で無効になり、1 回しか使えません。`,
    "心当たりがない場合は、このメールを無視してください。誰もログインできません。",
  ].join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.7">
<p>西田カメラへのログインです。アプリのログイン画面にこのコードを入力してください。</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
<p style="color:#666;font-size:13px">コードは ${CAMERA_CODE_TTL_MIN} 分で無効になり、1 回しか使えません。<br>心当たりがない場合は、このメールを無視してください。誰もログインできません。</p>
</div>`;
  return { subject: `西田カメラ ログインコード: ${code}`, text, html };
}

/**
 * ログインコードのメールを頼む。使えない人にはメールを送らないが、返事は同じにする
 * （誰が会員・招待者かを外から調べられないように）。
 */
export async function requestCameraLogin(email: string, ip: string | null): Promise<void> {
  if (ip && !(await hitLimit(`camera-mail-ip:${ip}`, CAMERA_LIMITS.mailPerIp))) {
    throw new CameraError(429, "rate_limited", TOO_MANY);
  }
  if (!(await hitLimit(`camera-mail:${email}`, CAMERA_LIMITS.mailPerEmail))) {
    throw new CameraError(429, "rate_limited", TOO_MANY);
  }
  // 確認とメールは返事のあとで行う: 使える人かどうかで返事の速さ・中身が変わらないように。
  void sendCameraCode(email, ip).catch((e) => console.error("[camera] login mail:", (e as Error)?.message));
}

async function sendCameraCode(email: string, ip: string | null): Promise<void> {
  const kind = await cameraEligibility(email);
  if (!kind) return;

  await pool.query(
    `UPDATE camera_login_requests SET expires_at = now() WHERE email = $1 AND used_at IS NULL AND expires_at > now()`,
    [email]
  );
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const ins = await pool.query(
    `INSERT INTO camera_login_requests (email, code_hash, ip, expires_at)
     VALUES ($1, '', $2, now() + make_interval(mins => $3)) RETURNING id`,
    [email, ip, CAMERA_CODE_TTL_MIN]
  );
  const id = Number(ins.rows[0].id);
  await pool.query(`UPDATE camera_login_requests SET code_hash = $2 WHERE id = $1`, [id, sha256(`${id}:${code}`)]);
  await sendEmail({ to: email, ...loginMail(code) });
}

async function failuresExceeded(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const r = await pool.query(
    `SELECT count FROM rate_limits WHERE key = $1 AND window_start >= now() - ($2::text)::interval`,
    [`camera-fail:${ip}`, CAMERA_LIMITS.failPerIp.window]
  );
  return Number(r.rows[0]?.count ?? 0) >= CAMERA_LIMITS.failPerIp.limit;
}

async function recordFailure(ip: string | null): Promise<void> {
  if (!ip) return;
  try {
    await hitLimit(`camera-fail:${ip}`, CAMERA_LIMITS.failPerIp);
  } catch {
    /* 制限機構の故障でログインを止めない */
  }
}

export interface CameraSession {
  token: string;
  email: string;
  kind: CameraKind;
}

/** コードを確かめて鍵を出す。鍵（平文）を返すのはこのときだけ。 */
export async function verifyCameraLogin(
  email: string,
  code: string,
  device: string,
  ip: string | null
): Promise<CameraSession> {
  if (await failuresExceeded(ip)) throw new CameraError(429, "rate_limited", TOO_MANY);
  const fail = async (msg = "コードが違うか、有効期限が切れています。もう一度メールを送ってください") => {
    await recordFailure(ip);
    return new CameraError(400, "invalid_code", msg);
  };
  if (!/^\d{6}$/.test(code)) throw await fail("6 桁の数字を入力してください");
  const r = await pool.query(
    `SELECT id, code_hash, attempts FROM camera_login_requests
      WHERE email = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  const row = r.rows[0];
  if (!row) throw await fail();
  // 回数は照合の前に数える（同時に何通送られても 5 回を超えない）。
  const counted = await pool.query(
    `UPDATE camera_login_requests SET attempts = attempts + 1
      WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2 RETURNING id`,
    [row.id, CAMERA_MAX_CODE_ATTEMPTS]
  );
  if (!counted.rows[0]) throw await fail("入力の回数が上限に達しました。もう一度メールを送ってください");
  const expected = Buffer.from(String(row.code_hash), "hex");
  const got = Buffer.from(sha256(`${row.id}:${code}`), "hex");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw await fail("コードが違います");
  }
  const used = await pool.query(
    `UPDATE camera_login_requests SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [row.id]
  );
  if (!used.rows[0]) throw await fail();

  // コードを送ったあとで招待を取り消された・退会した、もありうるので、鍵を出す前にもう一度確かめる。
  let kind: CameraKind | null;
  try {
    kind = await cameraEligibility(email);
  } catch {
    throw new CameraError(502, "membership_unavailable", "会員情報を確認できません。しばらくしてから再試行してください");
  }
  if (!kind) throw new CameraError(403, "forbidden", "このアドレスでは使えません");

  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO camera_tokens (token_hash, email, kind, device_name, expires_at, last_check)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), now())`,
    [sha256(token), email, kind, device.slice(0, 80), CAMERA_TOKEN_SLIDING_DAYS]
  );
  // 端末ごとの鍵は 5 本まで（古いものから無効に）。
  await pool.query(
    `UPDATE camera_tokens SET revoked_at = now()
      WHERE email = $1 AND revoked_at IS NULL AND id NOT IN (
        SELECT id FROM camera_tokens WHERE email = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT $2)`,
    [email, CAMERA_MAX_TOKENS_PER_EMAIL]
  );
  return { token, email, kind };
}

export interface CameraUser {
  tokenId: number;
  email: string;
  kind: CameraKind;
}

/** Authorization: Bearer <カメラの鍵> を確かめる。使えなくなった人の鍵はここで失効させる。 */
export async function verifyCameraToken(
  authHeader: string | null,
  ip: string | null,
  /** false: 使った日時と期限を延ばさない（待ちの表示の問い合わせは 1 秒に 1〜2 回来るので書き込まない）。 */
  touch = true
): Promise<CameraUser> {
  const m = /^Bearer\s+(\S+)$/i.exec((authHeader ?? "").trim());
  if (!m) throw new CameraError(401, "unauthorized", "ログインが必要です");
  if (await failuresExceeded(ip)) throw new CameraError(429, "rate_limited", TOO_MANY);
  const r = await pool.query(
    `SELECT id, email, kind, expires_at, revoked_at, last_check FROM camera_tokens WHERE token_hash = $1`,
    [sha256(m[1])]
  );
  const row = r.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
    await recordFailure(ip);
    throw new CameraError(401, "unauthorized", "ログインし直してください");
  }
  const email: string = row.email;
  let kind: CameraKind = row.kind;

  const revoke = async () => {
    await pool.query(`UPDATE camera_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    throw new CameraError(401, "unauthorized", "このアドレスでは使えなくなりました");
  };
  if (kind === "guest") {
    // 招待の取り消しはすぐ効かせる（Ghost と違って DB 1 回で済む）。会員になっていれば member に上げる。
    if (!(await inviteActive(email))) {
      const now = await cameraEligibility(email).catch(() => null);
      if (now !== "member") await revoke();
      kind = "member";
      // 会員になっていた: 次からは会員として 6 時間ごとの確認に回す（毎回 Ghost に聞かない）。
      await pool.query(`UPDATE camera_tokens SET kind = 'member', last_check = now() WHERE id = $1`, [row.id]);
    }
  }
  const last = row.last_check ? new Date(row.last_check).getTime() : 0;
  if (kind === "member" && Date.now() - last >= CAMERA_RECHECK_HOURS * 3600_000) {
    try {
      const now = await cameraEligibility(email);
      if (!now) await revoke();
      kind = now!;
      await pool.query(`UPDATE camera_tokens SET last_check = now(), kind = $2 WHERE id = $1`, [row.id, kind]);
    } catch (e) {
      if (e instanceof CameraError) throw e;
      if (!(e instanceof GhostUnavailableError) || Date.now() - last >= CAMERA_GRACE_HOURS * 3600_000) {
        throw new CameraError(503, "membership_unavailable", "会員情報を確認できません。少し時間をおいて試してください");
      }
    }
  }
  if (touch) {
    await pool.query(
      `UPDATE camera_tokens SET last_used_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`,
      [row.id, CAMERA_TOKEN_SLIDING_DAYS]
    );
  }
  return { tokenId: Number(row.id), email, kind };
}

export async function revokeCameraToken(tokenId: number): Promise<void> {
  await pool.query(`UPDATE camera_tokens SET revoked_at = now() WHERE id = $1`, [tokenId]);
}

// ---------------------------------------------------------------- 加工

/** 1 人同時 1 件（pm2 は 1 プロセス）。 */
const inFlight = new Set<string>();

/** アプリがつけた番号 → 誰の加工か・どこまで進んだか。待ちの表示（/api/camera/status）に使う。 */
interface ActiveJob {
  email: string;
  stage: "sending" | "receiving";
  cache?: { at: number; value: CameraJobStatus };
  /** dk5090 に聞いている最中の問い合わせ。同時に来た問い合わせはこれを待つ（1 件につき同時 1 本）。 */
  asking?: Promise<CameraJobStatus>;
  /** 待ちの表示の問い合わせの回数（1 秒ごと）。 */
  window?: { at: number; n: number };
}
/** 待ちの表示の問い合わせは 1 件につき 1 秒 4 回まで（アプリは 0.6 秒ごと）。 */
const STATUS_PER_SECOND = 4;
const activeJobs = new Map<string, ActiveJob>();
const JOB_ID = /^[0-9A-Za-z-]{8,64}$/;

export interface EditRequest {
  image: Buffer;
  preset: string | null;
  prompt: string | null;
  aspect: string;
  seed: number | null;
  /** アプリがつけた番号（待ちの表示用）。0.2.0 までのアプリは送らない。 */
  job?: string | null;
}

/** アプリの JSON を読む（形の確認だけ。誰が何を使えるかは runCameraEdit）。 */
export function parseEditBody(raw: unknown): EditRequest {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new CameraError(400, "invalid_request", "リクエストの形が違います");
  const image = typeof b.image === "string" ? Buffer.from(b.image, "base64") : Buffer.alloc(0);
  if (image.length < 100) throw new CameraError(400, "invalid_request", "写真がありません");
  const preset = typeof b.preset === "string" ? b.preset : null;
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : null;
  if (!preset && !prompt) throw new CameraError(400, "invalid_request", "プリセットかプロンプトが必要です");
  if (preset && !(CAMERA_PRESET_IDS as readonly string[]).includes(preset)) {
    throw new CameraError(400, "bad_preset", "そのプリセットはありません");
  }
  if (prompt && prompt.length > CAMERA_MAX_PROMPT) {
    throw new CameraError(400, "bad_prompt", `プロンプトは ${CAMERA_MAX_PROMPT} 文字までです`);
  }
  const aspect = typeof b.aspect === "string" ? b.aspect : "3:4";
  if (!["3:4", "4:3", "1:1", "9:16", "16:9"].includes(aspect)) {
    throw new CameraError(400, "bad_aspect", "縦横比が対応外です");
  }
  const seed = Number.isInteger(b.seed) && (b.seed as number) >= 0 && (b.seed as number) < 2 ** 31 ? (b.seed as number) : null;
  const job = typeof b.job === "string" && JOB_ID.test(b.job) ? b.job : null;
  return { image, preset: preset ?? null, prompt: preset ? null : prompt, aspect, seed, job };
}

/** dk5090 は約 2MP で加工する。縦横比に切り抜く分を見て少し大きめに送る。 */
const PHOTO_MAX_PIXELS = 2_400_000;
const PHOTO_MAX_SIDE = 2048;

/** 写真を描き直す: 形式の確認・向きを正す・約 2.4MP・メタデータを落とした JPEG。細工したファイルを家に送らない。 */
export async function sanitizePhoto(buf: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(buf, { limitInputPixels: 40_000_000 }).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const w = (swap ? meta.height : meta.width) ?? 0;
    const h = (swap ? meta.width : meta.height) ?? 0;
    const scale = Math.min(1, Math.sqrt(PHOTO_MAX_PIXELS / Math.max(1, w * h)), PHOTO_MAX_SIDE / Math.max(1, w, h));
    return await sharp(buf, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate()
      .resize({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    throw new CameraError(400, "bad_image", "写真を読めませんでした（JPEG / PNG を送ってください）");
  }
}

/** dk5090 に送る署名。dk5090 の promptcam_gateway.py の relay_signature と同じ並び。 */
export function relaySignature(
  key: string,
  user: string,
  ts: string,
  nonce: string,
  body: Buffer,
  method = "POST",
  path = "/v1/edit"
): string {
  const msg = [method, path, user, ts, nonce, sha256(body)].join("\n");
  return crypto.createHmac("sha256", key).update(msg).digest("hex");
}

export interface EditResult {
  jpeg: Buffer;
  seed: string;
  elapsed: string;
}

async function logEdit(user: CameraUser, req: EditRequest, status: string, ms: number): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO camera_log (email, kind, preset, prompt, status, ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.email, user.kind, req.preset, req.prompt, status, Math.round(ms)]
    );
  } catch (e) {
    console.error("[camera] log:", (e as Error)?.message);
  }
}

/** 回数・権限を確かめて dk5090 に頼む。写真と結果はメモリの中だけ。 */
export async function runCameraEdit(user: CameraUser, req: EditRequest): Promise<EditResult> {
  const t0 = Date.now();
  if (req.prompt && !cameraFreeTextFor(user.email)) {
    await logEdit(user, req, "free_text_refused", 0);
    throw new CameraError(403, "free_text_not_allowed", "自由入力はまだ使えません。プリセットを選んでください");
  }
  if (inFlight.has(user.email)) throw new CameraError(429, "busy", "前の加工が終わってからもう一度");
  inFlight.add(user.email);
  // 同じ番号が使われていたら（他人の番号をまねた等）、番号なしとして扱う。人の表示を上書きしない。
  const job = req.job && !activeJobs.has(req.job) ? req.job : null;
  if (job) activeJobs.set(job, { email: user.email, stage: "sending" });
  try {
    return await relayEdit(user, { ...req, job }, t0);
  } finally {
    inFlight.delete(user.email);
    if (job) activeJobs.delete(job);
  }
}

/** dk5090 のログに残すのはメールそのものではなく、鍵を混ぜた短い印（候補のメールから逆算できない）。 */
function userTagFor(key: string, email: string): string {
  return crypto.createHmac("sha256", key).update(`camera-user:${email}`).digest("hex").slice(0, 12);
}

function signedHeaders(key: string, email: string, body: Buffer, method: string, path: string): Record<string, string> {
  const user = userTagFor(key, email);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  return { "X-PC-User": user, "X-PC-Ts": ts, "X-PC-Nonce": nonce, "X-PC-Sig": relaySignature(key, user, ts, nonce, body, method, path) };
}

export interface CameraJobStatus {
  /** sending（送っている）/ preparing / gpu（GPU の準備待ち）/ queued / running / receiving / unknown */
  phase: string;
  ahead?: number;
  eta?: number;
  typical?: number;
  slow?: boolean;
}

const PHASES = new Set(["preparing", "gpu", "queued", "running"]);

/** 自分の加工がいまどこか（アプリの待ちの表示）。dk5090 への問い合わせは 1 件につき 0.4 秒に 1 回まで。 */
export async function cameraJobStatus(user: CameraUser, job: string): Promise<CameraJobStatus> {
  const a = activeJobs.get(job);
  if (!a || a.email !== user.email) return { phase: "unknown" };
  const now = Date.now();
  if (!a.window || now - a.window.at >= 1000) a.window = { at: now, n: 0 };
  if (++a.window.n > STATUS_PER_SECOND) throw new CameraError(429, "rate_limited", "問い合わせが多すぎます");
  if (a.stage === "receiving") return { phase: "receiving" };
  if (a.cache && now - a.cache.at < 400) return a.cache.value;
  if (!a.asking) {
    a.asking = askJobStatus(user, job, a).finally(() => {
      a.asking = undefined;
    });
  }
  return a.asking;
}

async function askJobStatus(user: CameraUser, job: string, a: ActiveJob): Promise<CameraJobStatus> {
  const url = process.env.PROMPTCAM_RELAY_URL;
  const key = process.env.PROMPTCAM_RELAY_KEY;
  let value: CameraJobStatus = { phase: "sending" };
  if (url && key && JOB_ID.test(job)) {
    const path = `/v1/status?job=${job}`;
    try {
      const res = await relayHttp(`${url.replace(/\/+$/, "")}${path}`, {
        method: "GET",
        pool: "small",
        headers: () => signedHeaders(key, user.email, Buffer.alloc(0), "GET", path),
        timeoutMs: 5_000,
        maxBytes: 4096,
      });
      const j = res.status === 200 ? (JSON.parse(res.body.toString()) as Record<string, unknown>) : {};
      if (typeof j.phase === "string" && PHASES.has(j.phase)) {
        value = { phase: j.phase };
        if (Number.isInteger(j.ahead)) value.ahead = Math.min(99, Math.max(0, j.ahead as number));
        if (typeof j.eta === "number" && isFinite(j.eta)) value.eta = Math.min(600, Math.max(0, j.eta));
        if (typeof j.typical === "number" && isFinite(j.typical)) value.typical = Math.min(600, Math.max(0, j.typical));
        if (typeof j.slow === "boolean") value.slow = j.slow;
      }
    } catch {
      /* 待ちの表示だけなので、届かなければ「送っている」のまま */
    }
  }
  if (activeJobs.get(job) === a && a.stage === "sending") a.cache = { at: Date.now(), value };
  return a.stage === "sending" ? value : { phase: "receiving" };
}

async function relayEdit(user: CameraUser, req: EditRequest, t0: number): Promise<EditResult> {
  const ok =
    (await hitLimit(`camera-edit-h:${user.email}`, CAMERA_LIMITS.editPerHour)) &&
    (await hitLimit(`camera-edit-d:${user.email}`, CAMERA_LIMITS.editPerDay)) &&
    (await hitLimit(`camera-edit-all`, CAMERA_LIMITS.editAllPerHour));
  if (!ok) {
    await logEdit(user, req, "rate_limited", 0);
    throw new CameraError(429, "rate_limited", "回数の上限です。しばらくしてからもう一度");
  }

  const url = process.env.PROMPTCAM_RELAY_URL;
  const key = process.env.PROMPTCAM_RELAY_KEY;
  if (!url || !key) throw new CameraError(503, "not_configured", "加工サーバーにつながりません（設定がありません）");

  {
    const photo = await sanitizePhoto(req.image);
    const body = Buffer.from(
      JSON.stringify({
        image: photo.toString("base64"),
        aspect: req.aspect,
        ...(req.preset ? { preset: req.preset } : { prompt: req.prompt }),
        ...(req.seed != null ? { seed: req.seed } : {}),
        ...(req.job ? { job: req.job } : {}),
      })
    );
    let res: RelayResponse;
    try {
      res = await relayHttp(`${url.replace(/\/+$/, "")}/v1/edit`, {
        method: "POST",
        headers: () => ({ "Content-Type": "application/json", ...signedHeaders(key, user.email, body, "POST", "/v1/edit") }),
        body,
        // dk5090 は GPU の確保に最大 60 秒・順番待ち 45 秒・加工数秒。それより長く待つ。
        timeoutMs: 115_000,
        maxBytes: 20 * 1024 * 1024,
        onResponse: () => {
          const a = req.job ? activeJobs.get(req.job) : undefined;
          if (a) a.stage = "receiving";
        },
      });
    } catch (e) {
      console.error("[camera] relay:", (e as Error)?.message);
      await logEdit(user, req, "unreachable", Date.now() - t0);
      throw new CameraError(502, "unreachable", "加工サーバー（dk5090）につながりません。少し時間をおいて試してください");
    }
    if (res.status < 200 || res.status >= 300) {
      let msg = `加工サーバーのエラー（${res.status}）`;
      let code = "relay_error";
      try {
        const j = JSON.parse(res.body.toString()) as { message?: string; error?: string };
        if (typeof j.message === "string") msg = j.message.slice(0, 200);
        if (typeof j.error === "string") code = j.error.slice(0, 40);
      } catch {
        /* JSON でない */
      }
      await logEdit(user, req, code, Date.now() - t0);
      throw new CameraError(res.status === 429 ? 429 : 502, code, msg);
    }
    const type = String(res.headers["content-type"] ?? "");
    const jpeg = res.body;
    if (!type.startsWith("image/jpeg")) {
      await logEdit(user, req, "bad_response", Date.now() - t0);
      throw new CameraError(502, "bad_response", "加工サーバーの答えがおかしいです");
    }
    await logEdit(user, req, "ok", Date.now() - t0);
    return {
      jpeg,
      seed: String(res.headers["x-seed"] ?? "").replace(/\D/g, "").slice(0, 12),
      elapsed: String(res.headers["x-elapsed"] ?? "").replace(/[^\d.]/g, "").slice(0, 8),
    };
  }
}

export function cameraProfile(user: CameraUser) {
  return {
    email: user.email,
    kind: user.kind,
    free_text: cameraFreeTextFor(user.email),
    can_invite: isAdmin(user.email),
  };
}

/** 30 日より古い記録と、使い終わったコード・鍵を消す（housekeeping から 1 時間ごと）。 */
export async function purgeCameraRows(): Promise<number> {
  const a = await pool.query(`DELETE FROM camera_log WHERE created_at < now() - make_interval(days => $1)`, [CAMERA_LOG_DAYS]);
  const b = await pool.query(`DELETE FROM camera_login_requests WHERE created_at < now() - interval '1 day'`);
  const c = await pool.query(
    `DELETE FROM camera_tokens WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`
  );
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}
