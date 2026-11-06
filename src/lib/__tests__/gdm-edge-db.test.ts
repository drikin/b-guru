/**
 * 👥 グループ DM の端のケース（QA 2026-11-06）。gdm-db.test.ts と同じ準備。いま壊れている所は it.fails で印を付けている。
 *
 * 本物の PostgreSQL が要る。dm-db.test.ts と同じく DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run gdm-db --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

const pushes: { to: string[]; id: number; group: number }[] = [];
const syncs: { email: string; scope: Record<string, unknown> }[] = [];
vi.mock("../push-notify", () => ({
  pushDm: async () => 1,
  pushGdm: async (to: string[], id: number, group: number) => {
    pushes.push({ to: [...to].sort(), id, group });
    return to.length;
  },
  syncRead: async (email: string, scope: Record<string, unknown>) => {
    syncs.push({ email, scope });
    return 0;
  },
}));

type Mods = {
  db: typeof import("../db");
  gdm: typeof import("../gdm");
  api: typeof import("../gdm-api");
  personal: typeof import("../personal-live");
  user: typeof import("../user");
  posts: typeof import("../posts");
};
let m: Mods;
const stamp = Date.now();
const E = (k: string) => `gdm-${k}-${stamp}@test.local`;
const [A, B, C, D, OFF, NOLOGIN] = ["a", "b", "c", "d", "off", "nologin"].map(E);
type Actor = { email: string; userId: string };
let a: Actor, b: Actor, c: Actor, dd: Actor, off: Actor, nologin: Actor;
const personal: { to: string; ev: { type: string; data?: Record<string, unknown> } }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
type G = import("../gdm").GroupDto;
type Msg = import("../gdm").GMessageDto;

async function create(actor: Actor, ids: string[], name?: string): Promise<G> {
  const r = await m.api.gdmCreateApi(actor, { name, member_ids: ids });
  expect(r.status).toBe(201);
  return r.body.group as G;
}

d("👥 グループ DM（DB・端のケース）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      gdm: await import("../gdm"),
      api: await import("../gdm-api"),
      personal: await import("../personal-live"),
      user: await import("../user"),
      posts: await import("../posts"),
    };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    const mk = async (e: string) => ({ email: e, userId: await m.user.ensureUserId(e) });
    [a, b, c, dd, off, nologin] = await Promise.all([A, B, C, D, OFF, NOLOGIN].map(mk));
    await m.user.ensureUserId(m.posts.SYSTEM_EMAIL);
    for (const e of [A, B, C, D, OFF]) {
      await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`gdm-test-${e}`, e]);
    }
    await sql(
      `INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ'), ($3, 'たま'), ($4, 'ぽち') ON CONFLICT DO NOTHING`,
      [A, B, C, D]
    );
    for (const u of [a, b, c, dd]) m.personal.personalBus.on(m.personal.personalKey(u.email), (ev) => personal.push({ to: u.email, ev: ev as never }));
  });

  beforeEach(async () => {
    const on = [A, B, C, D, NOLOGIN].join(",");
    process.env.DM_ENABLED = on;
    process.env.GROUP_DM_ENABLED = on;
    personal.length = 0;
    pushes.length = 0;
    syncs.length = 0;
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm:gdm-%' OR key LIKE 'gdm-admin:gdm-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'gdm-test-%'`);
    await m.db.pool.end();
  });

  // QA: いま壊れている（直したら it に戻す）
  it("同時に最後の 2 人が抜けても、グループは残らない", async () => {
    const g = await create(a, [b.userId]);
    const rs = await Promise.allSettled([m.api.gdmRemoveMemberApi(a, String(g.id), a.userId), m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)]);
    console.log("[QA] 同時に抜けた応答", rs.map((r) => (r.status === "fulfilled" ? r.value.status : "throw: " + String((r.reason as Error)?.message).slice(0, 60))));
    expect(rs.every((r) => r.status === "fulfilled" && r.value.status === 200)).toBe(true);
    const left = await sql(`SELECT (SELECT count(*)::int FROM gdm_members WHERE group_id = $1) AS n, (SELECT count(*)::int FROM gdm_groups WHERE id = $1) AS g`, [g.id]);
    console.log("[QA] 同時に抜けた後", left.rows[0]);
    expect(left.rows[0]).toEqual({ n: 0, g: 0 });
  });

  it("作った人と、引き継ぐはずの人が同時に抜けても、作った人はメンバーの誰か", async () => {
    const g = await create(a, [b.userId, c.userId]);
    const first = (await sql(`SELECT email FROM gdm_members WHERE group_id = $1 AND email <> $2 ORDER BY joined_at, email LIMIT 1`, [g.id, A])).rows[0].email;
    const heir = [b, c].find((u) => u.email === first)!;
    await Promise.all([m.api.gdmRemoveMemberApi(a, String(g.id), a.userId), m.api.gdmRemoveMemberApi(heir, String(g.id), heir.userId)]);
    const r = await sql(`SELECT g.creator_email, EXISTS (SELECT 1 FROM gdm_members gm WHERE gm.group_id = g.id AND gm.email = g.creator_email) AS ok FROM gdm_groups g WHERE id = $1`, [g.id]);
    console.log("[QA] 引き継ぎ", r.rows[0]);
    expect(r.rows[0].ok).toBe(true);
  });

  it("外すと抜けるが同時でも、system 行は 1 つ", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await Promise.all([m.api.gdmRemoveMemberApi(a, String(g.id), b.userId), m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)]);
    const r = await sql(`SELECT body FROM gdm_messages WHERE group_id = $1 AND kind = 'system' AND body LIKE '%みけ%' AND body NOT LIKE '%作りました%' ORDER BY id`, [g.id]);
    console.log("[QA] system 行", r.rows.map((x) => x.body));
    expect(r.rowCount).toBe(1);
  });

  // QA: いま壊れている（直したら it に戻す）
  it("既読はまだ無い発言の id まで進められない（先の発言が未読にならなくなる）", async () => {
    const g = await create(a, [b.userId]);
    const rr = await m.api.gdmReadApi(b, String(g.id), { last_read_id: 2147483647 });
    expect(rr.status).toBe(200);
    await m.gdm.sendGroupMessage(a, g.id, "あとから");
    const th = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    console.log("[QA] 先まで既読にした後の未読", th.body.unread_count, "last_read_id", th.body.last_read_id);
    expect(th.body.unread_count).toBe(1);
  });

  it("外されてからまた入ると、前の発言は見えず、未読は 0 から", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await m.gdm.sendGroupMessage(a, g.id, "1 回目");
    await m.api.gdmRemoveMemberApi(a, String(g.id), c.userId);
    await m.gdm.sendGroupMessage(a, g.id, "いない間");
    expect((await m.api.gdmAddMembersApi(b, String(g.id), { user_ids: [c.userId] })).status).toBe(200);
    const th = await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams());
    const bodies = (th.body.messages as Msg[]).map((x) => x.body);
    expect(bodies).not.toContain("1 回目");
    expect(bodies).not.toContain("いない間");
    expect(th.body.unread_count).toBe(0);
    expect((await m.api.gdmListApi(c)).body.group_unread_count).toBe(0);
  });

  // QA: いま壊れている（直したら it に戻す）
  it("外された人が同じ client_id で再送しても、送れたことにならない", async () => {
    const g = await create(a, [b.userId, c.userId]);
    const first = await m.api.gdmSendApi(c, String(g.id), { body: "x", client_id: "dup-1" });
    expect(first.status).toBe(201);
    await m.api.gdmRemoveMemberApi(a, String(g.id), c.userId);
    const again = await m.api.gdmSendApi(c, String(g.id), { body: "x", client_id: "dup-1" });
    console.log("[QA] 外された後の再送", again.status);
    expect(again.status).toBe(404);
  });

  it("名前の正規化: 見えない文字・改行・絵文字・40 字", async () => {
    const n = m.gdm.normalizeGroupName;
    expect(n("a\r\nb\tc")).toEqual({ ok: true, name: "a b c" });
    expect(n("   ")).toEqual({ ok: true, name: null });
    expect(n("😀".repeat(40))).toEqual({ ok: true, name: "😀".repeat(40) });
    expect(n("😀".repeat(41))).toEqual({ ok: false });
    console.log("[QA] 家族の絵文字 6 個（code point 42）", n("👨‍👩‍👧".repeat(6)).ok, "/ UTF-16 長", "👨‍👩‍👧".repeat(6).length);
    console.log("[QA] U+2028", JSON.stringify(n("a b")), " ゼロ幅だけ", JSON.stringify(n("​")), " U+202E", JSON.stringify(n("‮abc")));
    expect(n(123)).toEqual({ ok: false });
  });

  // QA: いま壊れている（直したら it に戻す）
  it("PATCH で同じ名前と muted を一緒に送ると、自分のほかの端末にも mute が届く", async () => {
    const g = await create(a, [b.userId], "部活");
    personal.length = 0;
    await m.api.gdmUpdateApi(b, String(g.id), { name: "部活", muted: true });
    expect(personal.some((p) => p.to === B && p.ev.data?.action === "group")).toBe(true);
  });

  it("limit・before の変な値で 500 にならない", async () => {
    const g = await create(a, [b.userId]);
    for (const q of ["limit=0", "limit=abc", "limit=99999", "before=-1", "before=1e3", "before=99999999999"]) {
      expect((await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams(q))).status).toBe(200);
    }
    for (const id of ["0", "-1", "1.5", "99999999999", " 1"]) {
      expect([400, 404]).toContain((await m.api.gdmMessageApi(a, id)).status);
    }
    expect((await m.api.gdmReadApi(a, String(g.id), { last_read_id: "abc" })).status).toBe(400);
    expect((await m.api.gdmReadApi(a, String(g.id), {})).status).toBe(400);
  });

  // QA: いま壊れている（直したら it に戻す）
  it("会員でなくなった人・対象外になった人にも push が行くか", async () => {
    const g = await create(a, [b.userId, c.userId]);
    process.env.GROUP_DM_ENABLED = [A, C, D].join(",");
    await m.gdm.sendGroupMessage(a, g.id, "まだいる？");
    // push は会員かを確かめてから非同期で出る。対象の C には届き、対象外の B には届かない
    await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(0));
    expect(pushes[0].to).toEqual([C]);
  });
});
