/**
 * 📜 台本（単独の機能）: 有料会員は読める・管理者だけ直せる・同時に直しても消し合わない・チェック欄の切り替え。
 *   DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-script-board --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { checksToMarks, countChecks, toggleNthCheck } from "../neta-script";

describe("チェック欄の小物", () => {
  const md = "## 確認\n\n- [ ] 音声\n- [x] 録音\n  * [ ] 入れ子\n本文の [ ] は対象外\n- [X] 大文字";
  it("数える・n 番目を切り替える・範囲の外は null", () => {
    expect(countChecks(md)).toBe(4);
    expect(toggleNthCheck(md, 0)).toContain("- [x] 音声");
    expect(toggleNthCheck(md, 1)).toContain("- [ ] 録音");
    expect(toggleNthCheck(md, 2)).toContain("  * [x] 入れ子");
    expect(toggleNthCheck(md, 3)).toContain("- [ ] 大文字");
    expect(toggleNthCheck(md, 4)).toBeNull();
    expect(toggleNthCheck(md, -1)).toBeNull();
    expect(toggleNthCheck(md, 1.5)).toBeNull();
    // ほかの行は変えない
    expect(toggleNthCheck(md, 0)!.replace("- [x] 音声", "- [ ] 音声")).toBe(md);
  });
  it("見る画面では ☐ / ☑", () => {
    const m = checksToMarks(md);
    expect(m).toContain("- ☐ 音声");
    expect(m).toContain("- ☑ 録音");
    expect(m).toContain("- ☑ 大文字");
    expect(m).toContain("本文の [ ] は対象外");
  });
});

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

d("📜 台本", () => {
  let db: typeof import("../db");
  let auth: typeof import("../agent-auth");
  let enter: typeof import("../../app/neta/app/enter/route");
  let get: typeof import("../../app/api/script/route");
  let rw: typeof import("../../app/api/script/[weekId]/route");
  const stamp = Date.now();
  const week = 8_000_000 + (stamp % 100_000);

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
    enter = await import("../../app/neta/app/enter/route");
    get = await import("../../app/api/script/route");
    rw = await import("../../app/api/script/[weekId]/route");
    await db.pool.query(`UPDATE neta_weeks SET is_active = false WHERE is_active`);
    await db.pool.query(`INSERT INTO neta_weeks (id, title, start_date, end_date, is_active) VALUES ($1, 'ep7777', '2026-11-08', '2026-11-15', true)`, [week]);
  });

  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { host: "localhost", ...(body !== undefined ? { "content-type": "application/json", origin: "http://localhost" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = { params: Promise.resolve({ weekId: String(week) }) };
  const login = async (email: string) => {
    const t = await auth.issueAgentToken({ email, scopes: ["read", "post"], deviceName: `iPhone-${stamp}-${email}`, appIssued: true });
    jar.clear();
    const r = await enter.GET(new Request("http://localhost/neta/app/enter?to=script", { headers: { authorization: `Bearer ${t.token}` } }) as never);
    return r;
  };

  it("ログインしていない人は読めない", async () => {
    jar.clear();
    expect((await get.GET(req("GET", "/api/script"))).status).toBe(401);
  });

  it("アプリの 📜 タブの入口は /neta/app/script へ。会員は読めるが直せない", async () => {
    const r = await login(`member-${stamp}@test.local`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/neta/app/script");
    const g = await get.GET(req("GET", "/api/script"));
    expect(g.status).toBe(200);
    const j = await g.json();
    expect(j.admin).toBe(false);
    expect(j.weekId).toBe(week);
    expect(j.script).toBeNull();
    expect((await rw.PUT(req("PUT", `/api/script/${week}`, { content: "x", base: null }), ctx)).status).toBe(403);
    expect((await rw.PATCH(req("PATCH", `/api/script/${week}`, { check: 0 }), ctx)).status).toBe(403);
    expect((await rw.POST(req("POST", `/api/script/${week}`, {}), ctx)).status).toBe(403);
  });

  it("管理者: 作る・同時に直したら 409・上書き・チェック欄", async () => {
    await login("zenjinishikawa@gmail.com");
    // よそのページからは書けない
    const cross = new NextRequest(`http://localhost/api/script/${week}`, {
      method: "PUT",
      headers: { host: "localhost", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ content: "x", base: null }),
    });
    expect((await rw.PUT(cross, ctx)).status).toBe(403);

    const regen = await (await rw.POST(req("POST", `/api/script/${week}`, {}), ctx)).json();
    expect(typeof regen.content).toBe("string"); // 前の週の台本（テストの DB では別のテストのもの）がもと

    const first = await rw.PUT(req("PUT", `/api/script/${week}`, { content: "# 台本\n- [ ] 音声\n- [ ] 録音\n", base: null }), ctx);
    expect(first.status).toBe(200);
    const v1 = (await first.json()).script;
    expect(v1.updatedBy).not.toContain("@");
    // もう 1 人も「まだない」と思って作る → 409
    const dup = await rw.PUT(req("PUT", `/api/script/${week}`, { content: "別の台本", base: null }), ctx);
    expect(dup.status).toBe(409);
    expect((await dup.json()).script.content).toContain("音声");
    // 読んだ版で保存 → 通る。古い版で保存 → 409（相手の版つき）
    const ok = await rw.PUT(req("PUT", `/api/script/${week}`, { content: "# 台本\n- [ ] 音声\n- [ ] 録音\n- [ ] 配信\n", base: v1.updatedAt }), ctx);
    expect(ok.status).toBe(200);
    const v2 = (await ok.json()).script;
    const stale = await rw.PUT(req("PUT", `/api/script/${week}`, { content: "古い", base: v1.updatedAt }), ctx);
    expect(stale.status).toBe(409);
    const sj = await stale.json();
    expect(sj.code).toBe("conflict");
    expect(sj.script.updatedAt).toBe(v2.updatedAt);
    // 相手の版を base にすれば上書きできる
    expect((await rw.PUT(req("PUT", `/api/script/${week}`, { content: "# 台本\n- [ ] 音声\n- [ ] 録音\n", base: v2.updatedAt }), ctx)).status).toBe(200);

    // チェック欄: 2 番目を入れて、続けて 1 番目（両方残る）
    const c1 = await (await rw.PATCH(req("PATCH", `/api/script/${week}`, { check: 1 }), ctx)).json();
    expect(c1.script.content).toContain("- [x] 録音");
    const c2 = await (await rw.PATCH(req("PATCH", `/api/script/${week}`, { check: 0 }), ctx)).json();
    expect(c2.script.content).toContain("- [x] 音声");
    expect(c2.script.content).toContain("- [x] 録音");
    expect((await rw.PATCH(req("PATCH", `/api/script/${week}`, { check: 5 }), ctx)).status).toBe(409);
    expect((await rw.PATCH(req("PATCH", `/api/script/${week}`, { check: "0" }), ctx)).status).toBe(400);

    // 会員にも同じ台本が見える
    await login(`member2-${stamp}@test.local`);
    const j = await (await get.GET(req("GET", `/api/script?week=${week}`))).json();
    expect(j.script.content).toContain("- [x] 音声");
    expect(j.weeks.find((w: { id: number }) => w.id === week).hasScript).toBe(true);
  });
});
