/**
 * メールでの本人確認ログイン。
 *
 * 1. requestLogin: 有料会員なら、6 桁のコードとログインボタン（リンク）を 1 通のメールで送る。
 *    会員でなくても返事は同じ（誰が会員かを外から調べられないように）。
 * 2. verifyLoginCode / verifyLoginLink: どちらかが合えばログイン。10 分で無効、1 回限り。
 *    コードの入力は 1 通あたり 5 回まで。新しいメールを頼むと前のコードとリンクは無効になる。
 * 3. ログインしたら「新しい端末でログインしました」メールを送る。そこにある
 *    「全端末ログアウト」リンク（30 日有効）で、本人がすべてのセッションとトークンを切れる。
 *
 * コード・リンク・ログアウトリンクは SHA-256 だけを DB に置く（平文はメールにだけ載る）。
 * 回数制限は rate_limits テーブルの固定窓（agent-auth と同じ方式）。
 */
import crypto from "crypto";
import { cookies } from "next/headers";
import { pool } from "./db";
import { findMemberByEmail, isPaidMember } from "./ghost";
import { sendEmail } from "./mailgun";

export const LOGIN_TTL_MIN = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const REVOKE_LINK_TTL_DAYS = 30;

/** 回数制限（固定窓）。key ごとに window の中で limit 回まで。 */
export const LOGIN_LIMITS = {
  /** 同じアドレスへのログインメール */
  mailPerEmail: { limit: 5, window: "1 hour" },
  /** 同じ IP からのログインメール依頼 */
  mailPerIp: { limit: 20, window: "1 hour" },
  /** 同じ IP からの確認失敗（コード違い・無効なリンク） */
  failPerIp: { limit: 30, window: "1 hour" },
} as const;

const BASE_URL = (process.env.APP_BASE_URL || "https://bsm.backspace.fm").replace(/\/+$/, "");

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** コードは行 id と混ぜてハッシュする（同じコードでも行ごとに別の値になる）。 */
export function hashCode(id: number, code: string): string {
  return sha256(`${id}:${code}`);
}

export function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newLinkToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export class LoginError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TOO_MANY = "試行回数が多すぎます。しばらくしてからもう一度お試しください";

/** 固定窓カウンタを 1 つ進め、上限内なら true。 */
export async function hitLimit(key: string, rule: { limit: number; window: string }): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                           THEN now() ELSE rate_limits.window_start END,
       count = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                    THEN 1 ELSE rate_limits.count + 1 END
     RETURNING count`,
    [key, rule.window]
  );
  return Number(res.rows[0]?.count ?? 0) <= rule.limit;
}

/** 失敗回数が上限に達しているか（数は進めない）。 */
async function failuresExceeded(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const res = await pool.query(
    `SELECT count FROM rate_limits WHERE key = $1 AND window_start >= now() - ($2::text)::interval`,
    [`login-fail:${ip}`, LOGIN_LIMITS.failPerIp.window]
  );
  return Number(res.rows[0]?.count ?? 0) >= LOGIN_LIMITS.failPerIp.limit;
}

async function recordFailure(ip: string | null): Promise<void> {
  if (!ip) return;
  try {
    await hitLimit(`login-fail:${ip}`, LOGIN_LIMITS.failPerIp);
  } catch {
    /* 制限機構の故障でログインを止めない */
  }
}

function loginMail(code: string, link: string) {
  const text = [
    "B-guru へのログインです。",
    "",
    "このブラウザでログインするなら、次のリンクを開いてください。",
    link,
    "",
    `アプリやほかの端末では、ログイン画面にこのコードを入力してください: ${code}`,
    "",
    `リンクとコードは ${LOGIN_TTL_MIN} 分で無効になり、1 回しか使えません。`,
    "心当たりがない場合は、このメールを無視してください。誰もログインできません。",
  ].join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.7">
<p>B-guru へのログインです。</p>
<p><a href="${link}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">ログインする</a></p>
<p>アプリやほかの端末では、ログイン画面にこのコードを入力してください。</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
<p style="color:#666;font-size:13px">リンクとコードは ${LOGIN_TTL_MIN} 分で無効になり、1 回しか使えません。<br>心当たりがない場合は、このメールを無視してください。誰もログインできません。</p>
</div>`;
  return { subject: `B-guru ログインコード: ${code}`, text, html };
}

/**
 * ログインメールを頼む。会員でない・回数オーバーでないかぎり、呼び出し側は
 * 会員かどうかに関係なく同じ返事を返すこと。
 * 投げる: LoginError(429)（回数オーバー）, LoginError(502)（Ghost / メール送信の失敗）
 */
export async function requestLogin(email: string, ip: string | null): Promise<void> {
  if (ip && !(await hitLimit(`login-mail-ip:${ip}`, LOGIN_LIMITS.mailPerIp))) {
    throw new LoginError(429, TOO_MANY);
  }
  if (!(await hitLimit(`login-mail:${email}`, LOGIN_LIMITS.mailPerEmail))) {
    throw new LoginError(429, TOO_MANY);
  }

  let member;
  try {
    member = await findMemberByEmail(email);
  } catch (e) {
    console.error("Ghost lookup error:", (e as Error)?.message);
    // Fail closed if Ghost is unreachable
    throw new LoginError(502, "認証サービスに接続できません。しばらくしてから再試行してください");
  }
  if (!member || !isPaidMember(member)) return;

  // 前に送ったコードとリンクは使えなくする（いつも最新の 1 通だけが有効）。
  await pool.query(
    `UPDATE login_requests SET expires_at = now() WHERE email = $1 AND used_at IS NULL AND expires_at > now()`,
    [email]
  );

  const code = newCode();
  const linkToken = newLinkToken();
  const ins = await pool.query(
    `INSERT INTO login_requests (email, code_hash, link_hash, ip, expires_at)
     VALUES ($1, '', $2, $3, now() + make_interval(mins => $4))
     RETURNING id`,
    [email, sha256(linkToken), ip, LOGIN_TTL_MIN]
  );
  const id = Number(ins.rows[0].id);
  await pool.query(`UPDATE login_requests SET code_hash = $2 WHERE id = $1`, [id, hashCode(id, code)]);

  // トークンは # の後ろに置く: サーバのログや、メールのリンク検査（URL を先に開くもの）に渡らない。
  const mail = loginMail(code, `${BASE_URL}/login/verify#t=${linkToken}`);
  try {
    await sendEmail({ to: email, ...mail });
  } catch (e) {
    console.error("[login] mail send failed:", (e as Error)?.message);
    throw new LoginError(502, "メールを送れませんでした。しばらくしてから再試行してください");
  }
}

export interface VerifiedLogin {
  email: string;
  requestId: number;
}

/** 6 桁のコードで確認。 */
export async function verifyLoginCode(email: string, code: string, ip: string | null): Promise<VerifiedLogin> {
  if (await failuresExceeded(ip)) throw new LoginError(429, TOO_MANY);
  const fail = async (msg = "コードが違うか、有効期限が切れています。もう一度メールを送ってください") => {
    await recordFailure(ip);
    return new LoginError(400, msg);
  };
  if (!/^\d{6}$/.test(code)) throw await fail("6 桁の数字を入力してください");

  const res = await pool.query(
    `SELECT id, code_hash, attempts FROM login_requests
      WHERE email = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  const row = res.rows[0];
  if (!row) throw await fail();
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    throw await fail("入力の回数が上限に達しました。もう一度メールを送ってください");
  }
  const expected = Buffer.from(String(row.code_hash), "hex");
  const got = Buffer.from(hashCode(Number(row.id), code), "hex");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    await pool.query(`UPDATE login_requests SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    throw await fail("コードが違います");
  }
  // 1 回限り: 同時に 2 回送られても片方だけが通る。
  const used = await pool.query(
    `UPDATE login_requests SET used_at = now()
      WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
      RETURNING id, email`,
    [row.id, MAX_CODE_ATTEMPTS]
  );
  if (!used.rows[0]) throw await fail();
  return { email: used.rows[0].email, requestId: Number(used.rows[0].id) };
}

/** メールのリンクで確認。 */
export async function verifyLoginLink(token: string, ip: string | null): Promise<VerifiedLogin> {
  if (await failuresExceeded(ip)) throw new LoginError(429, TOO_MANY);
  const res = await pool.query(
    `UPDATE login_requests SET used_at = now()
      WHERE link_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING id, email`,
    [sha256(token)]
  );
  if (!res.rows[0]) {
    await recordFailure(ip);
    throw new LoginError(400, "このリンクは使用済みか、有効期限が切れています。もう一度ログインメールを送ってください");
  }
  return { email: res.rows[0].email, requestId: Number(res.rows[0].id) };
}

/** 端末の説明（通知メール用）。User-Agent からざっくり。 */
export function describeDevice(ua: string | null): string {
  const u = ua ?? "";
  if (/B-guru|BguruChat/i.test(u)) return "B-guru アプリ";
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android"
    : /Mac OS X|Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "";
  const browser = /Edg\//.test(u) ? "Edge" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox"
    : /Safari\//.test(u) ? "Safari" : "";
  const s = [os, browser].filter(Boolean).join(" の ");
  return s || "不明な端末";
}

/**
 * ログインしたことを本人に知らせる（ベストエフォート — 失敗でログインを落とさない）。
 * 「全端末ログアウト」リンクを付ける。
 */
export async function notifyNewLogin(login: VerifiedLogin, ua: string | null): Promise<void> {
  const { email } = login;
  try {
    const revokeToken = newLinkToken();
    await pool.query(`UPDATE login_requests SET revoke_hash = $2 WHERE id = $1`, [
      login.requestId,
      sha256(revokeToken),
    ]);
    const when = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const device = describeDevice(ua);
    const link = `${BASE_URL}/login/revoke#t=${revokeToken}`;
    const text = [
      "B-guru に新しい端末でログインがありました。",
      "",
      `日時: ${when}`,
      `端末: ${device}`,
      "",
      "ご自身なら、このメールは無視してかまいません。",
      "心当たりがない場合は、次のリンクからすべての端末をログアウトしてください。",
      link,
    ].join("\n");
    const html = `<div style="font-family:sans-serif;line-height:1.7">
<p>B-guru に新しい端末でログインがありました。</p>
<p>日時: ${when}<br>端末: ${device}</p>
<p>ご自身なら、このメールは無視してかまいません。</p>
<p>心当たりがない場合は、<a href="${link}">ここからすべての端末をログアウト</a>してください。</p>
</div>`;
    await sendEmail({ to: email, subject: "B-guru: 新しい端末でログインしました", text, html });
  } catch (e) {
    console.error("[login] notify failed:", (e as Error)?.message);
  }
}

/** 「全端末ログアウト」リンクの確認。合えばメールアドレスを返す（何度押しても同じ結果）。 */
export async function verifyRevokeLink(token: string, ip: string | null): Promise<string> {
  if (await failuresExceeded(ip)) throw new LoginError(429, TOO_MANY);
  const res = await pool.query(
    `SELECT email FROM login_requests
      WHERE revoke_hash = $1 AND used_at > now() - make_interval(days => $2)`,
    [sha256(token), REVOKE_LINK_TTL_DAYS]
  );
  if (!res.rows[0]) {
    await recordFailure(ip);
    throw new LoginError(400, "このリンクは有効期限が切れています");
  }
  return res.rows[0].email;
}

// ---- セッションの延長と全端末ログアウト ----
// lib/session.ts は VPS 上に別作業の未コミット変更があり、deploy.sh がその md5 を
// 確かめている（scripts/deploy.sh）。ここに置いて session.ts は触らない。

const SESSION_COOKIE = "bsm_session";
/** 最後に使ってからこの日数まで有効（使い続けている端末はログインし直しにならない）。 */
export const SESSION_SLIDING_DAYS = 90;
/** cookie は DB の期限より長く持たせる（400 日はブラウザの上限）。有効かどうかは DB が決める。 */
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 400;

/**
 * このブラウザのセッションの期限を延ばす（1 日に 1 回まで）。/api/auth/me から呼ぶ。
 * 延ばしたときは cookie も付け直す。失敗してもログアウトさせない。
 */
export async function slideSession(): Promise<void> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return;
    const res = await pool.query(
      `UPDATE sessions SET expires_at = now() + make_interval(days => $2)
        WHERE token = $1 AND expires_at > now()
          AND expires_at < now() + make_interval(days => $2) - interval '1 day'
        RETURNING token`,
      [token, SESSION_SLIDING_DAYS]
    );
    if (!res.rows[0]) return;
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SEC,
    });
  } catch (e) {
    console.error("[login] slide failed:", (e as Error)?.message);
  }
}

/** 本人のすべての Web セッションとアプリ・エージェント用トークンを切る（全端末ログアウト）。 */
export async function destroyAllSessionsFor(email: string): Promise<void> {
  const e = normalizeEmail(email);
  await pool.query(`DELETE FROM sessions WHERE email = $1`, [e]);
  await pool.query(
    `UPDATE agent_tokens SET revoked_at = now() WHERE email = $1 AND revoked_at IS NULL`,
    [e]
  );
}
