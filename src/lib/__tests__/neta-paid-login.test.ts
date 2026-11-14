/**
 * ログインの入口を 1 つに（lib/neta-auth.ts paidLoginFromNeta）: ネタ帳のログインで本人確認が済んだ人が
 * BSM の有料会員なら B-guru にも入る。無料会員・Ghost に届かないときは入れない。
 *   DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-paid-login --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

const mails: { to: string; subject: string }[] = [];
vi.mock("../mailgun", () => ({
  sendEmail: async (m: { to: string; subject: string }) => {
    mails.push(m);
    return { message: "ok" };
  },
}));
let ghostAnswer: "paid" | "free" | "none" | "down" = "paid";
vi.mock("../ghost", async (orig) => {
  const real = (await orig()) as typeof import("../ghost");
  return {
    ...real,
    findMemberByEmail: async (email: string) => {
      if (ghostAnswer === "down") throw new real.GhostUnavailableError("down", true);
      if (ghostAnswer === "none") return null;
      return { id: "g1", email, status: ghostAnswer };
    },
    createFreeMember: async () => null,
  };
});
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

d("ログインの入口を 1 つに", () => {
  let db: typeof import("../db");
  let a: typeof import("../neta-auth");
  const stamp = Date.now();

  beforeAll(async () => {
    db = await import("../db");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
    a = await import("../neta-auth");
  });

  it("有料会員: B-guru のセッション（bsm_session）ができ、新しい端末の通知メールが行き、全端末ログアウトのリンクも効く行がある", async () => {
    const email = `paid-${stamp}@test.local`;
    jar.clear();
    mails.length = 0;
    ghostAnswer = "paid";
    expect(await a.paidLoginFromNeta(email, "203.0.113.5", "Mozilla/5.0 (Macintosh)")).toBe(true);
    const tok = jar.get("bsm_session");
    expect(tok).toBeTruthy();
    expect((await db.pool.query(`SELECT email FROM sessions WHERE token = $1`, [tok])).rows[0]?.email).toBe(email);
    await new Promise((r) => setTimeout(r, 50));
    expect(mails.some((m) => m.to === email && m.subject.includes("新しい端末"))).toBe(true);
    const lr = (await db.pool.query(`SELECT used_at, revoke_hash FROM login_requests WHERE email = $1`, [email])).rows[0];
    expect(lr.used_at).not.toBeNull();
    expect(lr.revoke_hash).toBeTruthy();
    // この行は B-guru のコードのログインに使えない（使用済み）
    const { verifyLoginCode } = await import("../login");
    await expect(verifyLoginCode(email, "000000", null)).rejects.toThrow();
  });

  it("無料会員・Ghost にいない・Ghost に届かない: B-guru には入れない", async () => {
    for (const ans of ["free", "none", "down"] as const) {
      jar.clear();
      ghostAnswer = ans;
      expect(await a.paidLoginFromNeta(`x-${ans}-${stamp}@test.local`, null, null)).toBe(false);
      expect(jar.has("bsm_session")).toBe(false);
    }
  });

  it("全端末ログアウトでネタ帳のログインも切れる", async () => {
    const email = `revoke-${stamp}@test.local`;
    jar.clear();
    const m = await a.ensureNetaMember(email);
    await a.startNetaSession(m.id);
    expect((await a.getNetaViewer())?.member?.id).toBe(m.id);
    const { destroyAllSessionsFor } = await import("../login");
    await destroyAllSessionsFor(email);
    expect(await a.getNetaViewer()).toBeNull();
  });
});
