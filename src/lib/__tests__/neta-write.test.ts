/**
 * 📝 ネタ帳の第 2 段階（lib/neta-auth.ts・lib/neta-write.ts）: ログイン、聞きたい、投稿、コメント。
 * 小物はそのまま、DB を使う部分は DM_TEST_DATABASE_URL があるときだけ（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-write --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

const mails: { to: string; text: string }[] = [];
vi.mock("../mailgun", () => ({
  sendEmail: async (m: { to: string; text: string }) => {
    mails.push(m);
    return { message: "ok" };
  },
}));
const ghostCreated: string[] = [];
vi.mock("../ghost", () => ({
  findMemberByEmail: async () => null,
  createFreeMember: async (email: string) => {
    ghostCreated.push(email);
    return { id: `g-${email}`, email, status: "free" };
  },
}));
// cookie はテストの中の入れ物で代わりをする。
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

describe("📝 ネタ帳の書き込みの小物", async () => {
  const w = await import("../neta-write");
  const a = await import("../neta-auth");

  it("投稿できる URL は http(s) で ID/パスワードなし", () => {
    expect(w.netaTopicUrl(" https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(w.netaTopicUrl("javascript:alert(1)")).toBeNull();
    expect(w.netaTopicUrl("https://user:pw@example.com/")).toBeNull();
    expect(w.netaTopicUrl("http://localhost/")).toBeNull();
    expect(w.netaTopicUrl("x".repeat(2001))).toBeNull();
  });

  it("名前は 1 行・30 字まで・見えない文字を外す", () => {
    expect(w.netaDisplayName("  ねこ\n‮田中 ")).toBe("ねこ 田中");
    expect(w.netaDisplayName("あ".repeat(40))).toBe("あ".repeat(30));
    expect(w.netaDisplayName(123)).toBe("");
  });

  it("出演者・運営と紛らわしい名前は使えない", () => {
    expect(w.netaReservedName("ドリキン")).toBe(true);
    expect(w.netaReservedName("ﾄﾞﾘｷﾝ（本物）")).toBe(true);
    expect(w.netaReservedName("D r i k i n")).toBe(true);
    expect(w.netaReservedName("西川 善司")).toBe(true);
    expect(w.netaReservedName("ねこ")).toBe(false);
  });

  it("ログイン後の戻り先は /neta の中だけ", () => {
    expect(a.netaNext("/neta/t/12")).toBe("/neta/t/12");
    expect(a.netaNext("/neta?sort=new")).toBe("/neta?sort=new");
    expect(a.netaNext("/netaxyz")).toBe("/neta");
    expect(a.netaNext("https://evil.example/neta")).toBe("/neta");
    expect(a.netaNext("//evil.example")).toBe("/neta");
    expect(a.netaNext("/neta/\\evil")).toBe("/neta");
  });

  it("書き込みは NETA_WRITE_ENABLED=1 で全員、それまでは管理者（有料会員のログイン）だけ", () => {
    const prev = process.env.NETA_WRITE_ENABLED;
    delete process.env.NETA_WRITE_ENABLED;
    expect(w.netaWritable(null)).toBe(false);
    expect(w.netaWritable({ email: "drikin@gmail.com", tier: "paid" })).toBe(true);
    expect(w.netaWritable({ email: "drikin@gmail.com", tier: "free" })).toBe(false);
    expect(w.netaWritable({ email: "someone@example.com", tier: "paid" })).toBe(false);
    process.env.NETA_WRITE_ENABLED = "1";
    expect(w.netaWritable(null)).toBe(true);
    if (prev === undefined) delete process.env.NETA_WRITE_ENABLED;
    else process.env.NETA_WRITE_ENABLED = prev;
  });
});

d("📝 ネタ帳の書き込み（DB）", () => {
  let db: typeof import("../db");
  let w: typeof import("../neta-write");
  let a: typeof import("../neta-auth");
  const stamp = Date.now();
  const base = 800000 + (stamp % 50000);
  const EMAIL = `neta-${stamp}@test.local`;

  beforeAll(async () => {
    db = await import("../db");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
    w = await import("../neta-write");
    a = await import("../neta-auth");
    await db.pool.query(`UPDATE neta_weeks SET is_active = false WHERE is_active`);
    await db.pool.query(`INSERT INTO neta_weeks (id, title, start_date, end_date, is_active) VALUES ($1, 'w', '2026-11-08', '2026-11-15', true)`, [base]);
    await db.pool.query(
      `INSERT INTO neta_topics (id, week_id, title, url, submitter, legacy_stars) VALUES ($1, $2, '昔のネタ', 'https://old.example/1', 'たま', 4)`,
      [base, base]
    );
  });

  it("メールのコードでログインすると、ネタ帳の行と cookie ができ、Ghost に無料会員を作る", async () => {
    mails.length = 0;
    await a.requestNetaLogin(EMAIL, "203.0.113.9", "/neta/t/5");
    expect(mails).toHaveLength(1);
    const code = /コード: (\d{6})/.exec(mails[0].text)![1];
    expect(mails[0].text).toContain("/neta/login#t=");
    expect(mails[0].text).toContain("n=%2Fneta%2Ft%2F5");
    await expect(a.verifyNetaLogin({ email: EMAIL, code: code === "000000" ? "111111" : "000000" }, "203.0.113.9")).rejects.toThrow();
    const email = await a.verifyNetaLogin({ email: EMAIL, code }, "203.0.113.9");
    expect(email).toBe(EMAIL);
    // 1 回限り
    await expect(a.verifyNetaLogin({ email: EMAIL, code }, "203.0.113.9")).rejects.toThrow();

    const member = await a.ensureNetaMember(email);
    await a.startNetaSession(member.id);
    await a.linkGhostMember(member);
    expect(ghostCreated).toContain(EMAIL);
    const v = await a.getNetaViewer();
    expect(v?.tier).toBe("free");
    expect(v?.member?.id).toBe(member.id);
    // DB には token そのものは置かない
    const raw = jar.get(a.NETA_COOKIE)!;
    expect((await db.pool.query(`SELECT 1 FROM neta_sessions WHERE token_hash = $1`, [raw])).rows).toHaveLength(0);

    await a.endNetaSession();
    expect(await a.getNetaViewer()).toBeNull();
  });

  it("メールのリンクでもログインできる（1 回限り）", async () => {
    mails.length = 0;
    await a.requestNetaLogin(EMAIL, null);
    const token = /#t=([A-Za-z0-9_-]+)/.exec(mails[0].text)![1];
    expect(await a.verifyNetaLogin({ token }, null)).toBe(EMAIL);
    await expect(a.verifyNetaLogin({ token }, null)).rejects.toThrow();
  });

  it("聞きたいは 1 人 1 票、何度押しても同じ、外せる。数は昔の票 + 新しい票", async () => {
    const m = await a.ensureNetaMember(EMAIL);
    expect(await w.setVote(m, base, true)).toEqual({ voted: true, stars: 5 });
    expect(await w.setVote(m, base, true)).toEqual({ voted: true, stars: 5 });
    const other = await a.ensureNetaMember(`other-${EMAIL}`);
    expect((await w.setVote(other, base, true)).stars).toBe(6);
    expect(await w.setVote(m, base, false)).toEqual({ voted: false, stars: 5 });
    expect([...(await w.votedTopicIds(other.id, [base, base + 1]))]).toEqual([base]);
    await expect(w.setVote(m, 2_000_000_000, true)).rejects.toMatchObject({ status: 404 });
  });

  it("投稿は名前が要る・今週に入る・id は 1000 万から・自分の聞きたいが 1 つ入る・同じ URL は 409", async () => {
    const m = await a.ensureNetaMember(`poster-${EMAIL}`);
    await expect(w.createTopic(m, null, { url: "https://new.example/a", title: "新しいネタ" })).rejects.toMatchObject({ code: "need_name" });
    const r = await w.createTopic(m, null, { url: "https://new.example/a", title: " 新しいネタ ", description: "a\r\n\r\n\r\nb", name: "ぽち" });
    expect(r.id).toBeGreaterThanOrEqual(10_000_000);
    const row = (await db.pool.query(`SELECT week_id, title, description, submitter, member_id FROM neta_topics WHERE id = $1`, [r.id])).rows[0];
    expect(row).toMatchObject({ week_id: base, title: "新しいネタ", description: "a\n\nb", submitter: "ぽち", member_id: m.id });
    expect([...(await w.votedTopicIds(m.id, [r.id]))]).toEqual([r.id]);

    const again = { ...m, displayName: "ぽち" };
    await expect(w.createTopic(again, null, { url: "https://new.example/a", title: "同じ" })).rejects.toMatchObject({
      status: 409,
      extra: { existing: { id: r.id } },
    });
    await expect(w.createTopic(again, null, { url: "ftp://x.example/", title: "x" })).rejects.toMatchObject({ code: "url" });
    await expect(w.createTopic(again, null, { url: "https://x.example/", title: "   " })).rejects.toMatchObject({ code: "title" });
    await expect(w.createTopic(again, null, { url: "https://x.example/", title: "x", description: "あ".repeat(1001) })).rejects.toMatchObject({
      code: "description",
    });
  });

  it("コメントは名前つきで入り、空・長すぎ・ないネタは断る", async () => {
    const m = { ...(await a.ensureNetaMember(`poster-${EMAIL}`)), displayName: "ぽち" };
    const r = await w.addComment(m, null, base, { body: "  聞きたい！ " });
    const row = (await db.pool.query(`SELECT commenter, body, member_id FROM neta_comments WHERE id = $1`, [r.id])).rows[0];
    expect(row).toEqual({ commenter: "ぽち", body: "聞きたい！", member_id: m.id });
    expect(r.id).toBeGreaterThanOrEqual(10_000_000);
    await expect(w.addComment(m, null, base, { body: " " })).rejects.toMatchObject({ code: "body" });
    await expect(w.addComment(m, null, base, { body: "あ".repeat(1001) })).rejects.toMatchObject({ code: "body" });
    await expect(w.addComment(m, null, 2_000_000_000, { body: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("拡張（ログインなし）: 名前つきで入り、聞きたいは入らない。名前なし・送り元不明は断る。同じ URL は 409", async () => {
    const r = await w.createTopicFromExtension("198.51.100.7", { url: "https://ext.example/a", title: "拡張から", submitter: " ぽち ", description: "x" });
    const row = (await db.pool.query(`SELECT submitter, member_id FROM neta_topics WHERE id = $1`, [r.id])).rows[0];
    expect(row).toEqual({ submitter: "ぽち", member_id: null });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM neta_votes WHERE topic_id = $1`, [r.id])).rows[0].n).toBe(0);
    await expect(w.createTopicFromExtension("198.51.100.7", { url: "https://ext.example/b", title: "x" })).rejects.toMatchObject({ code: "name" });
    await expect(w.createTopicFromExtension(null, { url: "https://ext.example/b", title: "x", submitter: "a" })).rejects.toMatchObject({ status: 400 });
    await expect(w.createTopicFromExtension("198.51.100.7", { url: "https://ext.example/a", title: "x", submitter: "a" })).rejects.toMatchObject({ status: 409 });
  });

  it("B-guru の「ネタ帳に送る」は切り替えの後、B-guru の中に入る（答えの形は今までと同じ）", async () => {
    const n = await import("../neta");
    const prev = process.env.NETA_WRITE_ENABLED;
    process.env.NETA_WRITE_ENABLED = "1";
    try {
      const notCalled = (async () => {
        throw new Error("neta.backspace.fm には送らない");
      }) as unknown as typeof fetch;
      const ok = await n.submitToNeta({ url: "https://own.example/1", title: "中へ", description: null }, "ドリキン", notCalled);
      expect(ok).toMatchObject({ status: 201, body: { ok: true, site: "https://bsm.backspace.fm/neta" } });
      const dup = await n.submitToNeta({ url: "https://own.example/1", title: "中へ", description: null }, "だれか", notCalled);
      expect(dup).toMatchObject({ status: 409, body: { code: "duplicate", existing: { submitter: "ドリキン" } } });
    } finally {
      if (prev === undefined) delete process.env.NETA_WRITE_ENABLED;
      else process.env.NETA_WRITE_ENABLED = prev;
    }
  });
});
