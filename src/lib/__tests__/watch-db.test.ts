/**
 * 📺 YouTube 共同鑑賞の DB を通した確認（lib/watch.ts・lib/watch-api.ts）。
 *
 * 本物の PostgreSQL が要る。WATCH_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       WATCH_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run watch-db
 * YouTube には聞かない（oEmbed は差し替え）。
 *
 *  - 流す・一時停止・再生・シーク: 版が 1 つずつ進み、位置は「その時点の秒」、知らせにメールが載らない
 *  - 見たいものリスト: 何も流れていなければすぐ流す、同じ動画は 2 度入らない、30 本まで、外す・選んで流す
 *  - 終わった・再生できない: 今の動画・今の版のときだけ 1 回進む（何台から届いても）、リストが空なら止まる
 *  - 埋め込めない動画・おかしな URL は断る、YouTube に届かないときは仮の題で通す
 *  - チャットの 1 行: 流し始めたとき。2 分以内の次の動画は同じ行を書き換える
 *  - 6 時間触られていなければ片付ける、API の道順
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const URL_ = process.env.WATCH_TEST_DATABASE_URL;
process.env.WATCH_ENABLED = "1";
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  w: typeof import("../watch");
  api: typeof import("../watch-api");
  live: typeof import("../live");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `wt-a-${stamp}@test.local`;
const B = `wt-b-${stamp}@test.local`;
let a: { email: string; userId: string };
let b: { email: string; userId: string };
const live: { type: string; state?: unknown }[] = [];
let oembed: (id: string) => Response | Promise<Response>;

const V1 = "dQw4w9WgXcQ";
const V2 = "9bZkp7q19f0";
const V3 = "kJQP7kiw5Fk";

function ok(title: string, author = "チャンネル") {
  return new Response(JSON.stringify({ title, author_name: author }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

const watchEvents = () => live.filter((e) => e.type === "watch");

d("📺 YouTube 共同鑑賞（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      w: await import("../watch"),
      api: await import("../watch-api"),
      live: await import("../live"),
      user: await import("../user"),
    };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    a = { email: A, userId: await m.user.ensureUserId(A) };
    b = { email: B, userId: await m.user.ensureUserId(B) };
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`, [A, B]);
    m.live.liveBus.on("change", (ev: { type: string }) => live.push(ev));
  });

  beforeEach(async () => {
    await m.w._resetWatchForTest();
    await sql(`DELETE FROM chat_messages WHERE kind = 'notice' AND body LIKE '📺%'`);
    live.length = 0;
    oembed = (id) => ok(`動画 ${id}`);
    m.w._setFetchForTest((async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const v = new URL(u.searchParams.get("url")!).searchParams.get("v")!;
      return oembed(v);
    }) as typeof fetch);
  });

  it("流す・一時停止・再生・シーク: 版が進み、位置はその時点の秒、知らせに名前だけ", async () => {
    const t0 = Date.now();
    let s = await m.w.act(a, { action: "load", url: `https://www.youtube.com/watch?v=${V1}&t=10` }, t0);
    expect(s.video).toMatchObject({ video_id: V1, title: `動画 ${V1}`, channel: "チャンネル", by: "ねこ" });
    expect(s.playing).toBe(true);
    expect(s.position).toBe(0);
    expect(s.version).toBe(1);
    expect(s.last).toEqual({ by: "ねこ", action: "load" });

    s = await m.w.act(b, { action: "pause", position: 42.37 }, t0 + 45_000);
    expect(s).toMatchObject({ playing: false, position: 42.4, version: 2, last: { by: "みけ", action: "pause" } });

    // 位置を言わない再生は、今の位置（一時停止中なので 42.4）から。
    s = await m.w.act(a, { action: "play" }, t0 + 60_000);
    expect(s).toMatchObject({ playing: true, position: 42.4, version: 3 });
    expect(s.updated_at).toBe(t0 + 60_000);

    s = await m.w.act(a, { action: "seek", position: 300 }, t0 + 61_000);
    expect(s).toMatchObject({ playing: true, position: 300, version: 4 });

    const evs = watchEvents();
    expect(evs).toHaveLength(4);
    expect(JSON.stringify(evs)).not.toContain("@test.local");
    expect(JSON.stringify(evs)).not.toContain(a.userId); // 操作した人は名前だけ
  });

  it("動画がないときの再生・シークは断る、知らない操作も断る", async () => {
    await expect(m.w.act(a, { action: "play" })).rejects.toMatchObject({ status: 409, code: "no_video" });
    await expect(m.w.act(a, { action: "rm -rf" })).rejects.toMatchObject({ status: 400, code: "bad_action" });
    await expect(m.w.act(a, { action: "load", url: "https://example.com/watch?v=abc" })).rejects.toMatchObject({ code: "bad_video" });
    await expect(m.w.act(a, { action: "load", url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "bad_video" });
  });

  it("埋め込めない動画は断る。YouTube に届かないときは仮の題で通す", async () => {
    oembed = () => new Response("Unauthorized", { status: 401 });
    await expect(m.w.act(a, { action: "load", video_id: V1 })).rejects.toMatchObject({ status: 422, code: "not_embeddable" });
    oembed = () => {
      throw new Error("network");
    };
    const s = await m.w.act(a, { action: "load", video_id: V2 });
    expect(s.video).toMatchObject({ video_id: V2, title: "YouTube の動画", channel: null });
  });

  it("見たいものリスト: 空ならすぐ流す、重複と 30 本超えは断る、外す・選んで流す", async () => {
    let s = await m.w.act(a, { action: "queue_add", video_id: V1 });
    expect(s.video?.video_id).toBe(V1);
    expect(s.queue).toHaveLength(0);

    s = await m.w.act(b, { action: "queue_add", url: `https://youtu.be/${V2}` });
    s = await m.w.act(b, { action: "queue_add", url: `https://www.youtube.com/shorts/${V3}` });
    expect(s.video?.video_id).toBe(V1);
    expect(s.queue.map((q) => q.video_id)).toEqual([V2, V3]);
    expect(s.queue[0].by).toBe("みけ");
    await expect(m.w.act(a, { action: "queue_add", video_id: V2 })).rejects.toMatchObject({ code: "already_queued" });

    s = await m.w.act(a, { action: "queue_play", id: s.queue[1].id });
    expect(s.video?.video_id).toBe(V3);
    expect(s.queue.map((q) => q.video_id)).toEqual([V2]);

    s = await m.w.act(a, { action: "queue_remove", id: s.queue[0].id });
    expect(s.queue).toHaveLength(0);

    for (let i = 0; i < m.w.QUEUE_MAX; i++) {
      await sql(`INSERT INTO watch_queue (video_id, title, added_by) VALUES ($1, 'x', $2)`, [`q${String(i).padStart(10, "0")}`, a.userId]);
    }
    await expect(m.w.act(a, { action: "queue_add", video_id: V1 })).rejects.toMatchObject({ code: "queue_full" });
  });

  it("終わった・再生できない: 今の動画と版のときだけ 1 回進む。空なら止まる", async () => {
    await m.w.act(a, { action: "load", video_id: V1 });
    await m.w.act(a, { action: "queue_add", video_id: V2 });
    let s = await m.w.getState();
    const ver = s.version;

    // 3 台から同時に「終わった」。
    const outs = await Promise.all([a, b, a].map((u) => m.w.act(u, { action: "ended", video_id: V1, version: ver })));
    s = await m.w.getState();
    expect(s.video?.video_id).toBe(V2);
    expect(s.queue).toHaveLength(0);
    expect(outs.filter((o) => o.video?.video_id === V2)).toHaveLength(3);
    expect(s.version).toBe(ver + 1);

    // 古い版・違う動画の報告は何もしない（知らせも出さない）。
    live.length = 0;
    s = await m.w.act(a, { action: "ended", video_id: V1, version: ver });
    expect(s.video?.video_id).toBe(V2);
    expect(watchEvents()).toHaveLength(0);

    // 再生できない → リストが空なので止まる。
    s = await m.w.act(b, { action: "error", video_id: V2, version: s.version, code: 150 });
    expect(s.video).toBeNull();
    expect(s.playing).toBe(false);
  });

  it("チャットの 1 行: 流し始めたとき。2 分以内の次の動画は同じ行を書き換える", async () => {
    const t0 = Date.now();
    await m.w.act(a, { action: "load", video_id: V1 }, t0);
    let rows = (await sql(`SELECT id, body FROM chat_messages WHERE kind = 'notice' AND body LIKE '📺%' ORDER BY id`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(`📺 ねこさんが「動画 ${V1}」をみんなで見始めたわん`);

    await m.w.act(b, { action: "pause", position: 3 }, t0 + 5_000); // 一時停止では出さない
    await m.w.act(b, { action: "load", video_id: V2 }, t0 + 60_000);
    rows = (await sql(`SELECT id, body FROM chat_messages WHERE kind = 'notice' AND body LIKE '📺%' ORDER BY id`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(`📺 みけさんが「動画 ${V2}」をみんなで見始めたわん`);

    await m.w.act(a, { action: "load", video_id: V3 }, t0 + 60_000 + m.w.NOTICE_MERGE_MS + 1);
    rows = (await sql(`SELECT id FROM chat_messages WHERE kind = 'notice' AND body LIKE '📺%'`)).rows;
    expect(rows).toHaveLength(2);
  });

  it("6 時間触られていなければ、次に読まれたときに片付ける", async () => {
    const t0 = Date.now();
    await m.w.act(a, { action: "load", video_id: V1 }, t0);
    expect((await m.w.getState(t0 + 1000)).video?.video_id).toBe(V1);
    const s = await m.w.getState(t0 + m.w.IDLE_MS + 1000);
    expect(s.video).toBeNull();
  });

  it("API の道順: state / action、知らない道は 404、エラーは { error, code }", async () => {
    const body = (x: unknown) => async () => x as Record<string, unknown>;
    let r = await m.api.handleWatch("GET", ["state"], a, body(null));
    expect(r.status).toBe(200);
    expect((r.body as { state: { video: unknown } }).state.video).toBeNull();
    r = await m.api.handleWatch("POST", ["action"], a, body({ action: "load", video_id: V1 }));
    expect(r.status).toBe(200);
    expect((r.body as { state: { video: { video_id: string } } }).state.video.video_id).toBe(V1);
    r = await m.api.handleWatch("POST", ["action"], a, body({ action: "load", url: "nope" }));
    expect(r).toMatchObject({ status: 400, body: { code: "bad_video" } });
    r = await m.api.handleWatch("GET", ["nope"], a, body(null));
    expect(r.status).toBe(404);
    r = await m.api.handleWatch("POST", ["action"], a, async () => "too_large");
    expect(r.status).toBe(413);
  });
});

describe("📺 共同鑑賞（DB なし）", () => {
  it("動画の ID: URL の形と ID そのもの", async () => {
    const w = await import("../watch");
    expect(w.parseVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(w.parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s")).toBe("dQw4w9WgXcQ");
    expect(w.parseVideoId("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(w.parseVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(w.parseVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(w.parseVideoId("https://evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(w.parseVideoId("short")).toBeNull();
    expect(w.parseVideoId(123)).toBeNull();
    expect(w.clampPosition(-5)).toBe(0);
    expect(w.clampPosition("12.34")).toBe(12.3);
    expect(w.clampPosition(1e9)).toBe(86400);
    expect(w.clampPosition(NaN)).toBe(0);
  });

  it("連打よけ（Web）: 1 分 60 回", async () => {
    const w = await import("../watch");
    const t = 1_000_000;
    for (let i = 0; i < 60; i++) expect(w.webRateOk("u-rate", t + i)).toBe(true);
    expect(w.webRateOk("u-rate", t + 100)).toBe(false);
    expect(w.webRateOk("u-rate", t + 61_000)).toBe(true);
  });
});
