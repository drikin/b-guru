/**
 * 📝 ネタ帳のログイン（docs/neta-integration-plan.md、第 2 段階）。
 *
 * - 誰でもメールだけで参加できる（backspace.fm の無料会員になる）。B-guru のログイン（lib/login.ts）と同じく、
 *   6 桁のコードとリンクを 1 通のメールで送り、どちらかが合えばログイン。10 分・1 回限り・コードは 5 回まで。
 * - ネタ帳のログインは cookie neta_session と neta_sessions 表。無料会員には B-guru の sessions（＝有料会員）は出さない
 *   ので、B-guru の既存の機能（getSessionEmail を使う所）は何も開かない。BSM の有料会員と Ghost で確かめられた人だけ、
 *   B-guru のログインと同じ扱いで sessions も出す（paidLoginFromNeta、ログインの入口を 1 つに 2026-11-14）。
 * - 有料会員が B-guru にログインしていれば、そのままネタ帳でも本人として扱う（getNetaViewer）。
 * - Ghost に会員を作るのは、メールの確認が済んでから（他人のアドレスで勝手に会員を作れないように）。
 */
import crypto from "crypto";
import { cookies } from "next/headers";
import { pool } from "./db";
import { createFreeMember, findMemberByEmail, isPaidMember } from "./ghost";
import { hashCode, hitLimit, LoginError, LOGIN_LIMITS, LOGIN_TTL_MIN, MAX_CODE_ATTEMPTS, newCode, newLinkToken, notifyNewLogin } from "./login";
import { sendEmail } from "./mailgun";
import { createSession, getSessionEmail, setSessionCookie } from "./session";

export const NETA_COOKIE = "neta_session";
export const NETA_SESSION_DAYS = 180;
const BASE_URL = (process.env.APP_BASE_URL || "https://bsm.backspace.fm").replace(/\/+$/, "");
const TOO_MANY = "試行回数が多すぎます。しばらくしてからもう一度お試しください";

export type NetaMember = { id: number; email: string | null; displayName: string | null };
/** ネタ帳を見ている人。tier は B-guru の有料会員としてログインしているか（入り口の出し分けだけに使う）。 */
export type NetaViewer = { member: NetaMember | null; email: string; tier: "paid" | "free" };

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** ログイン後に戻る先。/neta の中だけ（よそへ飛ばさない）。 */
export function netaNext(raw: unknown): string {
  if (typeof raw !== "string") return "/neta";
  return /^\/neta(?:[/?#][^\s\\]*)?$/.test(raw) && !raw.startsWith("//") ? raw : "/neta";
}

function toMember(r: Record<string, unknown>): NetaMember {
  return { id: Number(r.id), email: (r.email as string | null) ?? null, displayName: (r.display_name as string | null) || null };
}

export async function findNetaMemberByEmail(email: string): Promise<NetaMember | null> {
  const r = await pool.query(`SELECT id, email, display_name FROM neta_members WHERE email = $1`, [email]);
  return r.rows[0] ? toMember(r.rows[0]) : null;
}

/** メールの人の行を（なければ作って）返す。 */
export async function ensureNetaMember(email: string): Promise<NetaMember> {
  const r = await pool.query(
    `INSERT INTO neta_members (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, display_name`,
    [email]
  );
  return toMember(r.rows[0]);
}

/** Ghost に会員がいなければ無料会員を作り、id を覚える（ベストエフォート。失敗してもネタ帳は使える。次のログインでまた試す）。 */
export async function linkGhostMember(member: NetaMember): Promise<void> {
  if (!member.email) return;
  try {
    const known = await pool.query(`SELECT ghost_member_id FROM neta_members WHERE id = $1`, [member.id]);
    if (known.rows[0]?.ghost_member_id) return;
    const g = (await findMemberByEmail(member.email)) ?? (await createFreeMember(member.email));
    if (g?.id) await pool.query(`UPDATE neta_members SET ghost_member_id = $2 WHERE id = $1`, [member.id, g.id]);
  } catch (e) {
    console.error("[neta-auth] ghost link failed:", (e as Error)?.message);
  }
}

function loginMail(code: string, link: string) {
  const text = [
    "backspace.fm のネタ帳へのログインです。",
    "",
    "このブラウザでログインするなら、次のリンクを開いてください。",
    link,
    "",
    `ログイン画面に入力するコード: ${code}`,
    "",
    `リンクとコードは ${LOGIN_TTL_MIN} 分で無効になり、1 回しか使えません。`,
    "初めての方は、backspace.fm の無料会員として登録されます（ニュースレターは届きません）。BSM の会員なら B-guru にも入れます。",
    "心当たりがない場合は、このメールを無視してください。誰もログインできず、登録もされません。",
  ].join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.7">
<p>backspace.fm のネタ帳へのログインです。</p>
<p><a href="${link}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">ログインする</a></p>
<p>ログイン画面に入力するコード</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
<p style="color:#666;font-size:13px">リンクとコードは ${LOGIN_TTL_MIN} 分で無効になり、1 回しか使えません。<br>初めての方は、backspace.fm の無料会員として登録されます（ニュースレターは届きません）。BSM の会員なら B-guru にも入れます。<br>心当たりがない場合は、このメールを無視してください。誰もログインできず、登録もされません。</p>
</div>`;
  return { subject: `ネタ帳・B-guru のログインコード: ${code}`, text, html };
}

/** ログインメールを送る。誰にでも送る（登録も兼ねる）ので、回数制限がスパム対策の最前線。 */
export async function requestNetaLogin(email: string, ip: string | null, next = "/neta"): Promise<void> {
  if (ip && !(await hitLimit(`neta-mail-ip:${ip}`, LOGIN_LIMITS.mailPerIp))) throw new LoginError(429, TOO_MANY);
  if (!(await hitLimit(`neta-mail:${email}`, LOGIN_LIMITS.mailPerEmail))) throw new LoginError(429, TOO_MANY);

  await pool.query(
    `UPDATE neta_login_requests SET expires_at = now() WHERE email = $1 AND used_at IS NULL AND expires_at > now()`,
    [email]
  );
  const code = newCode();
  const linkToken = newLinkToken();
  const ins = await pool.query(
    `INSERT INTO neta_login_requests (email, code_hash, link_hash, ip, expires_at)
     VALUES ($1, '', $2, $3, now() + make_interval(mins => $4)) RETURNING id`,
    [email, sha256(linkToken), ip, LOGIN_TTL_MIN]
  );
  const id = Number(ins.rows[0].id);
  await pool.query(`UPDATE neta_login_requests SET code_hash = $2 WHERE id = $1`, [id, hashCode(id, code)]);
  // トークンは # の後ろ（サーバのログやメールのリンク検査に渡らない）。戻り先も一緒に。
  const link = `${BASE_URL}/neta/login#t=${linkToken}&n=${encodeURIComponent(netaNext(next))}`;
  try {
    await sendEmail({ to: email, ...loginMail(code, link) });
  } catch (e) {
    console.error("[neta-auth] mail send failed:", (e as Error)?.message);
    throw new LoginError(502, "メールを送れませんでした。しばらくしてから再試行してください");
  }
}

async function failuresExceeded(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const res = await pool.query(
    `SELECT count FROM rate_limits WHERE key = $1 AND window_start >= now() - ($2::text)::interval`,
    [`neta-login-fail:${ip}`, LOGIN_LIMITS.failPerIp.window]
  );
  return Number(res.rows[0]?.count ?? 0) >= LOGIN_LIMITS.failPerIp.limit;
}

async function recordFailure(ip: string | null): Promise<void> {
  if (!ip) return;
  try {
    await hitLimit(`neta-login-fail:${ip}`, LOGIN_LIMITS.failPerIp);
  } catch {
    /* 制限機構の故障でログインを止めない */
  }
}

/** コードかリンクで確かめ、合えばメールアドレスを返す。 */
export async function verifyNetaLogin(input: { email?: string; code?: string; token?: string }, ip: string | null): Promise<string> {
  if (await failuresExceeded(ip)) throw new LoginError(429, TOO_MANY);
  const fail = async (msg: string) => {
    await recordFailure(ip);
    return new LoginError(400, msg);
  };
  if (input.token) {
    const res = await pool.query(
      `UPDATE neta_login_requests SET used_at = now()
        WHERE link_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email`,
      [sha256(input.token)]
    );
    if (!res.rows[0]) throw await fail("このリンクは使用済みか、有効期限が切れています。もう一度ログインメールを送ってください");
    return res.rows[0].email;
  }
  const email = input.email ?? "";
  const code = input.code ?? "";
  if (!/^\d{6}$/.test(code)) throw await fail("6 桁の数字を入力してください");
  const res = await pool.query(
    `SELECT id, code_hash, attempts FROM neta_login_requests
      WHERE email = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  const row = res.rows[0];
  if (!row) throw await fail("コードが違うか、有効期限が切れています。もう一度メールを送ってください");
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) throw await fail("入力の回数が上限に達しました。もう一度メールを送ってください");
  const expected = Buffer.from(String(row.code_hash), "hex");
  const got = Buffer.from(hashCode(Number(row.id), code), "hex");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    await pool.query(`UPDATE neta_login_requests SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    throw await fail("コードが違います");
  }
  const used = await pool.query(
    `UPDATE neta_login_requests SET used_at = now()
      WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2 RETURNING email`,
    [row.id, MAX_CODE_ATTEMPTS]
  );
  if (!used.rows[0]) throw await fail("コードが違うか、有効期限が切れています。もう一度メールを送ってください");
  return used.rows[0].email;
}

/** ネタ帳のセッションを作って cookie を付ける（Route Handler から）。 */
export async function startNetaSession(memberId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO neta_sessions (token_hash, member_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), memberId, NETA_SESSION_DAYS]
  );
  const store = await cookies();
  store.set(NETA_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: NETA_SESSION_DAYS * 86400,
  });
}

export async function endNetaSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(NETA_COOKIE)?.value;
  if (token) await pool.query(`DELETE FROM neta_sessions WHERE token_hash = $1`, [sha256(token)]);
  store.delete(NETA_COOKIE);
}

/**
 * 見ている人。B-guru の有料会員のログインが先（その人のネタ帳の行は、何かするまで無いこともある）、
 * なければネタ帳のログイン。どちらでもなければ null。
 */
export async function getNetaViewer(): Promise<NetaViewer | null> {
  const paid = await getSessionEmail().catch(() => null);
  if (paid) return { member: await findNetaMemberByEmail(paid), email: paid, tier: "paid" };
  const store = await cookies();
  const token = store.get(NETA_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await pool.query(
    `SELECT m.id, m.email, m.display_name FROM neta_sessions s JOIN neta_members m ON m.id = s.member_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  if (!r.rows[0]?.email) return null;
  const member = toMember(r.rows[0]);
  return { member, email: member.email!, tier: "free" };
}

/** 書き込みの前に: 見ている人のネタ帳の行を必ず用意する（有料会員の初回はここで作る）。 */
export async function requireNetaMember(): Promise<{ viewer: NetaViewer; member: NetaMember } | null> {
  const viewer = await getNetaViewer();
  if (!viewer) return null;
  const member = viewer.member ?? (await ensureNetaMember(viewer.email));
  return { viewer: { ...viewer, member }, member };
}

export function netaVoter(memberId: number): string {
  return `m:${memberId}`;
}

/**
 * ネタ帳のログインで本人確認が済んだ人が BSM の有料会員なら、B-guru にも入れる（B-guru のログインと同じ扱い）。
 * - 有料かどうかは B-guru のログイン（lib/login.ts）と同じ isPaidMember。Ghost に届かなければ入れない（ネタ帳だけ）。
 * - 「新しい端末でログインしました」メールの「全端末ログアウト」リンクのために、login_requests に使用済みの行を 1 つ作る。
 * 入れたら true。
 */
export async function paidLoginFromNeta(email: string, ip: string | null, ua: string | null): Promise<boolean> {
  let paid = false;
  try {
    const g = await findMemberByEmail(email);
    paid = !!g && isPaidMember(g);
  } catch (e) {
    console.error("[neta-auth] paid check failed:", (e as Error)?.message);
    return false;
  }
  if (!paid) return false;
  const token = await createSession(email);
  await setSessionCookie(token);
  try {
    const { ensureUserId } = await import("./user");
    await ensureUserId(email);
  } catch (e) {
    console.error("[neta-auth] ensureUserId failed:", (e as Error)?.message);
  }
  try {
    const r = await pool.query(
      `INSERT INTO login_requests (email, code_hash, link_hash, ip, expires_at, used_at)
       VALUES ($1, '', $2, $3, now(), now()) RETURNING id`,
      [email, sha256(crypto.randomBytes(32).toString("hex")), ip]
    );
    void notifyNewLogin({ email, requestId: Number(r.rows[0].id) }, ua);
  } catch (e) {
    console.error("[neta-auth] login notice failed:", (e as Error)?.message);
  }
  return true;
}

/** 画面に渡す形の「見ている人」（メールアドレスは入れない）と、聞きたいの印に使う id。 */
export async function viewerForClient(): Promise<{
  client: { viewer: { displayName: string | null; tier: "paid" | "free" } | null; writable: boolean; admin: boolean; live: boolean };
  memberId: number | null;
}> {
  const v = await getNetaViewer().catch(() => null);
  const { netaWritable, netaLive } = await import("./neta-write");
  const { isAdmin } = await import("./admin");
  return {
    client: {
      viewer: v ? { displayName: v.member?.displayName ?? null, tier: v.tier } : null,
      writable: netaWritable(v),
      admin: !!v && v.tier === "paid" && isAdmin(v.email),
      live: netaLive(),
    },
    memberId: v?.member?.id ?? null,
  };
}
