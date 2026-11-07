/**
 * 🐶 グループ DM のビーグル（lib/gdm.ts の answerGroupBeagle、lib/gdm-beagle.ts）。さくらは差し替える。
 *
 * 本物の PostgreSQL が要る。dm-db.test.ts と同じく DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run gdm-beagle-db --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
// 写真はテスト用の一時フォルダへ（リポジトリの data/ を汚さない）
process.env.GDM_PHOTO_DIR = `${require("os").tmpdir()}/gdm-photos-test-${process.pid}`;
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
const asks: { system: string; user: string }[] = [];
let nextAnswer = "まとめだわん";
vi.mock("../sakura", () => ({
  SAKURA_MODEL: "test-model",
  sakuraChat: async (o: { messages: { role: string; content: string }[] }) => {
    asks.push({ system: o.messages[0].content, user: o.messages[1].content });
    return { content: nextAnswer, model: "test-model" };
  },
}));
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

d("🐶 グループ DM のビーグル（DB）", () => {
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
    asks.length = 0;
    nextAnswer = "まとめだわん";
    process.env.BEAGLE_SERVER_ENABLED = ""; // 自動で答える分は止め、テストが answerGroupBeagle を呼ぶ（自動の分は専用のテストで）
    await sql(`DELETE FROM beagle_ai_log WHERE ai_by_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm:gdm-%' OR key LIKE 'gdm-admin:gdm-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'gdm-test-%'`);
    await m.db.pool.end();
  });

  const beagleMsgs = async (who: Actor, gid: number) =>
    ((await m.api.gdmThreadApi(who, String(gid), new URLSearchParams())).body.messages as Msg[]).filter((x) => x.is_beagle);

  it("既定は切: @ビーグル と書いても答えない", async () => {
    const g = await create(a, [b.userId]);
    expect(g.beagle).toBe(false);
    const q = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル まとめて");
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル まとめて", 0)).toBe(false);
    expect(asks).toHaveLength(0);
  });

  it("入れると全員に知らせ、答えは全員に見える（kind は text・送り主はビーグル）・push は通知を切っていない人へ", async () => {
    const g = await create(a, [b.userId, c.userId]);
    const r = await m.api.gdmUpdateApi(b, String(g.id), { beagle: true });
    expect(r.status).toBe(200);
    expect((r.body.group as G).beagle).toBe(true);
    const th = await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams());
    expect((th.body.messages as Msg[]).some((x) => x.kind === "system" && x.body.includes("ビーグルを呼べるようにしました") && x.body.includes("入る前の流れ"))).toBe(true);
    await m.api.gdmUpdateApi(c, String(g.id), { muted: true });
    await m.gdm.sendGroupMessage(b, g.id, "あしたは 10 時集合");
    const q = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル ここまでまとめて");
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル ここまでまとめて", 0)).toBe(true);
    expect(asks[0].user).toContain("10 時集合");
    expect(asks[0].user).toContain("質問: ここまでまとめて");
    for (const who of [a, b, c]) {
      const got = await beagleMsgs(who, g.id);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ kind: "text", from_name: "ビーグル", body: "まとめだわん", is_author: false });
    }
    const ans = (await beagleMsgs(a, g.id))[0];
    await vi.waitFor(() => expect(pushes.filter((p) => p.id === ans.id)).toHaveLength(1));
    expect(pushes.find((p) => p.id === ans.id)!.to).toEqual([A, B].sort());
    // 同じ質問には 1 回だけ
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル ここまでまとめて", 0)).toBe(false);
    // ビーグルの答えは未読に数える
    const list = await m.api.gdmListApi(b);
    expect(list.body.group_unread_count).toBeGreaterThanOrEqual(1);
    expect((list.body.groups as { group: G }[]).find((x) => x.group.id === g.id)!.group.beagle).toBe(true);
    const sum = (list.body.groups as { group: G; last_message: Msg | null }[]).find((x) => x.group.id === g.id)!;
    expect(sum.last_message?.is_beagle).toBe(true);
    expect(sum.last_message?.from_id).toBeNull();
    // 質問した人の未読にも数える（ビーグルの答えは本人の発言ではない）
    const mineList = await m.api.gdmListApi(a);
    expect((mineList.body.groups as { group: G; unread_count: number }[]).find((x) => x.group.id === g.id)!.unread_count).toBe(1);
    const one = await m.api.gdmMessageApi(b, String(sum.last_message!.id));
    expect(one.body.message).toMatchObject({ is_beagle: true, from_name: "ビーグル" });
  });

  it("途中から入った人には、入る前の発言も印つきで渡す（要約で伝える指示つき）", async () => {
    const g = await create(a, [b.userId]);
    await m.api.gdmUpdateApi(a, String(g.id), { beagle: true });
    await m.gdm.sendGroupMessage(b, g.id, "入る前の相談");
    await m.api.gdmAddMembersApi(a, String(g.id), { user_ids: [dd.userId] });
    await m.gdm.sendGroupMessage(a, g.id, "入ったあとの話");
    // 入った人は入る前の発言を画面では見られない
    const th = await m.api.gdmThreadApi(dd, String(g.id), new URLSearchParams());
    expect((th.body.messages as Msg[]).map((x) => x.body)).not.toContain("入る前の相談");
    const q = await m.gdm.sendGroupMessage(dd, g.id, "@ビーグル これまでの流れを教えて");
    const self = (await sql(`SELECT last_read_id FROM gdm_members WHERE group_id = $1 AND email = $2`, [g.id, D])).rows[0];
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, D, "@ビーグル これまでの流れを教えて", 0)).toBe(true);
    const u = asks[0].user;
    expect(u).toContain("入る前の相談");
    expect(u.indexOf("入る前の相談")).toBeLessThan(u.indexOf("入ったあとの発言"));
    expect(u.indexOf("入ったあとの発言")).toBeLessThan(u.indexOf("入ったあとの話"));
    expect(u).toContain("そのまま引用しない");
    expect(asks[0].system).toContain("そのまま引用しない");
    expect(self).toBeTruthy();
    // 答えは元からいる人にも見える
    expect(await beagleMsgs(b, g.id)).toHaveLength(1);
  });

  it("ほかのグループの発言は混ぜない", async () => {
    const g1 = await create(a, [b.userId]);
    const g2 = await create(a, [c.userId]);
    await m.gdm.sendGroupMessage(c, g2.id, "べつのグループのひみつ");
    await m.api.gdmUpdateApi(a, String(g1.id), { beagle: true });
    const q = await m.gdm.sendGroupMessage(a, g1.id, "@ビーグル まとめて");
    await m.gdm.answerGroupBeagle(g1.id, q.id, A, "@ビーグル まとめて", 0);
    expect(asks[0].user).not.toContain("べつのグループのひみつ");
  });

  it("考えているあいだに切られた・質問した人が抜けたら出さない／上限はチャットと共通", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await m.api.gdmUpdateApi(a, String(g.id), { beagle: true });
    const q = await m.gdm.sendGroupMessage(c, g.id, "@ビーグル おしえて");
    await m.api.gdmRemoveMemberApi(c, String(g.id), c.userId);
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, C, "@ビーグル おしえて", 0)).toBe(false);
    // 上限: 24 時間に 30 回使った人は答えない
    for (let i = 0; i < 30; i++) {
      await sql(`INSERT INTO beagle_ai_log (question_id, question_body, answer, ai_by_email, app) VALUES ($1, 'q', 'a', $2, 'server:x')`, [900000 + i, A]);
    }
    const q2 = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル もう一回");
    expect(await m.gdm.answerGroupBeagle(g.id, q2.id, A, "@ビーグル もう一回", 0)).toBe(false);
    // 切る: 全員に知らせ、そのあとは答えない
    await sql(`DELETE FROM beagle_ai_log WHERE ai_by_email = $1`, [A]);
    const off = await m.api.gdmUpdateApi(b, String(g.id), { beagle: false });
    expect((off.body.group as G).beagle).toBe(false);
    const q3 = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル まだいる？");
    expect(await m.gdm.answerGroupBeagle(g.id, q3.id, A, "@ビーグル まだいる？", 0)).toBe(false);
  });

  it("自動: 入れたグループで @ビーグル と送ると答える（BEAGLE_SERVER_ENABLED の人だけ）・同時に呼んでも答えは 1 つ", async () => {
    const g = await create(a, [b.userId]);
    await m.api.gdmUpdateApi(a, String(g.id), { beagle: true });
    process.env.BEAGLE_SERVER_ENABLED = A;
    await m.gdm.sendGroupMessage(b, g.id, "@ビーグル こんにちは"); // b は対象外
    const q = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル こんにちは");
    const extra = m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル こんにちは", 0);
    await vi.waitFor(async () => expect(await beagleMsgs(a, g.id)).toHaveLength(1));
    await extra;
    await new Promise((r) => setTimeout(r, 100));
    expect(await beagleMsgs(a, g.id)).toHaveLength(1);
    expect(asks.every((x) => !x.user.includes("質問した人: みけ"))).toBe(true);
  });

  it("グループが消えると、そのグループの質問と答えの記録も消える", async () => {
    const g = await create(a, [b.userId]);
    await m.api.gdmUpdateApi(a, String(g.id), { beagle: true });
    const q = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル まとめて");
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル まとめて", 0)).toBe(true);
    expect((await sql(`SELECT 1 FROM beagle_ai_log WHERE question_id = $1 AND app LIKE 'gdm:%'`, [q.id])).rowCount).toBe(1);
    await m.api.gdmRemoveMemberApi(a, String(g.id), a.userId);
    await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId);
    expect((await sql(`SELECT 1 FROM beagle_ai_log WHERE question_id = $1 AND app LIKE 'gdm:%'`, [q.id])).rowCount).toBe(0);
  });

  it("同じ値に切り替えてもお知らせは出ない・端末から gdm: を名乗った記録はグループの質問とぶつからない", async () => {
    const g = await create(a, [b.userId]);
    await m.api.gdmUpdateApi(a, String(g.id), { beagle: true });
    await m.api.gdmUpdateApi(b, String(g.id), { beagle: true });
    const th = await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams());
    expect((th.body.messages as Msg[]).filter((x) => x.body.includes("呼べるようにしました"))).toHaveLength(1);
    const q = await m.gdm.sendGroupMessage(a, g.id, "@ビーグル やあ");
    const od = await import("../beagle-ondevice");
    expect(od.sanitizeBeagleAnswer("x")).toBe("x");
    await sql(`INSERT INTO beagle_ai_log (question_id, question_body, answer, ai_by_email, app) VALUES ($1, 'q', 'a', $2, 'app-gdm:x')`, [q.id, B]);
    expect(await m.gdm.answerGroupBeagle(g.id, q.id, A, "@ビーグル やあ", 0)).toBe(true);
  });

  it("入・切の不正な値・メンバーでない人は断る", async () => {
    const g = await create(a, [b.userId]);
    expect((await m.api.gdmUpdateApi(a, String(g.id), { beagle: "yes" })).status).toBe(400);
    expect((await m.api.gdmUpdateApi(c, String(g.id), { beagle: true })).status).toBe(404);
  });
});
