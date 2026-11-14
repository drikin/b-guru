/**
 * アプリの 📝 タブの入口（/neta/app/enter）: アプリの鍵ならネタ帳だけのログイン（neta_session、12 時間）を置いて /neta/app へ。
 * 外部の AI エージェントの鍵・鍵なしは入れない。B-guru の sessions（bsm_session）は出さない。
 *   DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-app-tab --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

vi.mock("../ghost", async (orig) => {
  const real = (await orig()) as typeof import("../ghost");
  return { ...real, findMemberByEmail: async (email: string) => ({ id: "g1", email, status: "paid" }) };
});
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

d("アプリの 📝 タブの入口", () => {
  let db: typeof import("../db");
  let auth: typeof import("../agent-auth");
  let route: typeof import("../../app/neta/app/enter/route");
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
    auth = await import("../agent-auth");
    route = await import("../../app/neta/app/enter/route");
  });

  const call = (authz?: string) =>
    route.GET(new Request("http://localhost/neta/app/enter", { headers: authz ? { authorization: authz } : {} }) as never);

  it("アプリの鍵: ネタ帳のログインができて /neta/app へ（bsm_session は出さない）", async () => {
    const email = `app-${stamp}@test.local`;
    const t = await auth.issueAgentToken({ email, scopes: ["read", "post"], deviceName: "iPhone", appIssued: true });
    jar.clear();
    const r = await call(`Bearer ${t.token}`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/neta/app");
    expect(jar.has("bsm_session")).toBe(false);
    const tok = jar.get("neta_session");
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    const a = await import("../neta-auth");
    const v = await a.getNetaViewer();
    expect(v?.email).toBe(email);
    expect(v?.tier).toBe("free"); // 権限はネタ帳の会員と同じ（管理は Web の B-guru のログインだけ）
    const hrs = (await db.pool.query(`SELECT extract(epoch FROM expires_at - now()) / 3600 AS h FROM neta_sessions s JOIN neta_members m ON m.id = s.member_id WHERE m.email = $1`, [email])).rows[0].h;
    expect(Number(hrs)).toBeGreaterThan(11);
    expect(Number(hrs)).toBeLessThanOrEqual(12);
    // 元のアプリの鍵を失効させると、ネタ帳のログインも効かない
    await db.pool.query(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [t.tokenId]);
    expect(await a.getNetaViewer()).toBeNull();
  });

  it("外部の AI エージェントの鍵・鍵なし・でたらめな鍵: 入れない", async () => {
    const t = await auth.issueAgentToken({ email: `agent-${stamp}@test.local`, scopes: ["read", "post"], deviceName: "agent", appIssued: false });
    for (const h of [`Bearer ${t.token}`, undefined, "Bearer nope"]) {
      jar.clear();
      const r = await call(h);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(jar.size).toBe(0);
    }
  });
});
