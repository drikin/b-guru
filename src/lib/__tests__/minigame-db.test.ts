/**
 * 🎮 締め切りダッシュの DB を通した確認（lib/minigame.ts・lib/minigame-api.ts）。
 *
 * 本物の PostgreSQL が要る。事故を避けるため DATABASE_URL ではなく専用の
 * MINIGAME_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと。テーブルを作り、行を消す）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       MINIGAME_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run minigame-db
 *
 *  - 発行 → 提出: サーバの再生でスコアが決まる（申告値は照合だけ）、1 回限り、自分の回だけ
 *  - 弾く: 速度改造（刻み数/60 > 実時間 + 10 秒）、記録の上限（3 万件・64KB）、engine_version 違い、期限切れ（30 分）、壊れた記録
 *  - 順位表: 今日（今日のチャレンジ）・今週（自由）・通算、自分の順位、操作の記録は自己ベストの分だけ
 *  - 20 回を超えた最初の 1 回だけ rest_hint、配信（上位 10・本人のベスト。メールなし）
 *  - 公開後だけ: チャットの 1 行（1 位交代・上位 5 位、10 分以内はまとめる、1 日 10 行）、月曜 9 時の週の王者（1 本だけ）
 *  - 管理者: 記録を消す（順位表の作り直し）、ほかの人は 403
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { botRun } from "./minigame-bot";

const URL_ = process.env.MINIGAME_TEST_DATABASE_URL;
process.env.MINIGAME_ENABLED = "1";
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  mg: typeof import("../minigame");
  api: typeof import("../minigame-api");
  live: typeof import("../live");
  personal: typeof import("../personal-live");
  user: typeof import("../user");
  sim: typeof import("../minigame/sim");
};
let m: Mods;
const stamp = Date.now();
const A = `mg-a-${stamp}@test.local`;
const B = `mg-b-${stamp}@test.local`;
const ADMIN = "drikin@gmail.com";
let a: { email: string; userId: string };
let b: { email: string; userId: string };
let admin: { email: string; userId: string };
const live: unknown[] = [];
const personal: { to: string; ev: unknown }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

/** 発行して、記録の長さぶん発行時刻を昔にずらす（実時間で遊んだことにする）。 */
async function issue(actor: { email: string; userId: string }, mode: "daily" | "free", character = "drikin") {
  return m.mg.issuePlay(actor, { mode, character });
}
async function age(playId: number, seconds: number) {
  await sql(`UPDATE minigame_plays SET issued_at = now() - make_interval(secs => $2) WHERE id = $1`, [playId, seconds]);
}
async function playHonest(actor: { email: string; userId: string }, mode: "daily" | "free", opts: { lapse: number; rngSeed: number; character?: string }) {
  const ch = opts.character ?? "drikin";
  const t = await issue(actor, mode, ch);
  const run = botRun(t.seed, ch, { lapse: opts.lapse, rngSeed: opts.rngSeed });
  await age(t.play_id, Math.ceil(run.sim.tick / 60));
  const res = await m.mg.finishPlay(actor, t.play_id, { inputs: run.inputs, engine_version: 1, score: m.sim.scoreOf(run.sim) });
  return { ticket: t, run, res };
}

async function expectErr(p: Promise<unknown>, status: number, code: string) {
  await expect(p).rejects.toMatchObject({ status, code });
}

d("🎮 締め切りダッシュ（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      mg: await import("../minigame"),
      api: await import("../minigame-api"),
      live: await import("../live"),
      personal: await import("../personal-live"),
      user: await import("../user"),
      sim: await import("../minigame/sim"),
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
    admin = { email: ADMIN, userId: await m.user.ensureUserId(ADMIN) };
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`, [A, B]);
    m.live.liveBus.on("change", (ev) => live.push(ev));
    for (const u of [a, b]) m.personal.personalBus.on(m.personal.personalKey(u.email), (ev) => personal.push({ to: u.email, ev }));
    m.mg._setTopDelayForTest(20);
  });

  beforeEach(async () => {
    m.mg._resetMinigameForTest();
    live.length = 0;
    personal.length = 0;
    process.env.MINIGAME_ENABLED = "1";
    await sql(`DELETE FROM minigame_plays; DELETE FROM minigame_bests; DELETE FROM minigame_announces; DELETE FROM minigame_weekly;
               DELETE FROM chat_messages WHERE body LIKE '%締め切りダッシュ%'`);
  });

  afterAll(async () => {
    if (!m) return;
    m.mg._resetMinigameForTest();
    await sql(`DELETE FROM minigame_plays; DELETE FROM minigame_bests; DELETE FROM minigame_announces; DELETE FROM minigame_weekly`);
    await m.db.pool.end();
  });

  it("発行 → 提出: サーバの再生でスコアが決まり、順位表に載る（API の形）", async () => {
    const issued = await m.api.handleMinigame("POST", ["plays"], a, new URLSearchParams(), async () => ({ mode: "daily", character: "matsuo" }));
    expect(issued.status).toBe(201);
    const t = (issued.body as { play: import("../minigame/types").PlayTicket }).play;
    expect(t).toMatchObject({ mode: "daily", character: "matsuo", engine_version: 1, date: m.mg.dailyDate() });
    const info = await m.mg.getInfo(a);
    expect(t.seed).toBe(info.daily.seed); // 今日のチャレンジは全員同じ種
    const run = botRun(t.seed, "matsuo", { lapse: 100, rngSeed: 3 });
    await age(t.play_id, Math.ceil(run.sim.tick / 60));
    const out = await m.api.handleMinigame("POST", ["plays", String(t.play_id), "finish"], a, new URLSearchParams(), async () => ({
      inputs: run.inputs,
      engine_version: 1,
      score: 1, // 申告値は照合だけ
    }));
    expect(out.status).toBe(200);
    const res = (out.body as { result: import("../minigame/types").FinishResultDto }).result;
    expect(res).toMatchObject({
      play_id: t.play_id,
      mode: "daily",
      score: m.sim.scoreOf(run.sim),
      distance: m.sim.distanceM(run.sim),
      ticks: run.sim.tick,
      new_best: true,
      rank: 1,
      rank_today: 1,
      period: "today",
      plays_today: 1,
      rest_hint: false,
      mismatch: true,
    });
    const row = (await sql(`SELECT status, score, claimed_score, inputs IS NOT NULL AS has FROM minigame_plays WHERE id = $1`, [t.play_id])).rows[0];
    expect(row).toMatchObject({ status: "verified", score: res.score, claimed_score: 1, has: true });
    const boards = (await sql(`SELECT board FROM minigame_bests WHERE user_id = $1 ORDER BY board`, [a.userId])).rows.map((r) => r.board);
    expect(boards).toEqual(["all", "all:daily", `d:${m.mg.dailyDate()}`]);
    // 1 回限り
    await expectErr(m.mg.finishPlay(a, t.play_id, { inputs: run.inputs, engine_version: 1 }), 409, "already_finished");
    // 自分の回だけ
    const t2 = await issue(a, "free");
    await expectErr(m.mg.finishPlay(b, t2.play_id, { inputs: [], engine_version: 1 }), 404, "not_found");
  });

  it("速度改造（刻み数/60 > 実時間 + 10 秒）は弾く", async () => {
    const t = await issue(a, "free");
    const run = botRun(t.seed, "drikin", { lapse: 50, rngSeed: 1 });
    expect(run.sim.tick / 60).toBeGreaterThan(15);
    // 発行の直後に 15 秒以上ぶんの記録 → 弾く
    await expectErr(m.mg.finishPlay(a, t.play_id, { inputs: run.inputs, engine_version: 1 }), 422, "too_fast");
    const row = (await sql(`SELECT status, reject_reason FROM minigame_plays WHERE id = $1`, [t.play_id])).rows[0];
    expect(row).toEqual({ status: "rejected", reject_reason: "too_fast" });
    // ちょうど実時間 + 10 秒までは通る
    const t2 = await issue(a, "free");
    const run2 = botRun(t2.seed, "drikin", { lapse: 50, rngSeed: 1 });
    await age(t2.play_id, Math.ceil(run2.sim.tick / 60) - 9);
    expect((await m.mg.finishPlay(a, t2.play_id, { inputs: run2.inputs, engine_version: 1 })).score).toBe(m.sim.scoreOf(run2.sim));
  });

  it("記録の上限（3 万件・64KB）・engine_version 違い・期限切れ・壊れた記録", async () => {
    const t = await issue(a, "free");
    await expectErr(m.mg.finishPlay(a, t.play_id, { inputs: new Array(30001).fill(1), engine_version: 1 }), 413, "too_large");
    await expectErr(m.mg.finishPlay(a, t.play_id, { inputs: new Array(20000).fill(99999999), engine_version: 1 }), 413, "too_large");
    // 本文そのものが大きすぎる（route の読み方）
    const big = new Request("http://x/", { method: "POST", body: JSON.stringify({ inputs: new Array(30000).fill(1234567) }) });
    expect(await m.api.readJsonLimited(big)).toBe("too_large");
    // 上の 413 では状態を変えない（まだ出せる）
    expect((await sql(`SELECT status FROM minigame_plays WHERE id = $1`, [t.play_id])).rows[0].status).toBe("issued");

    await expectErr(m.mg.finishPlay(a, t.play_id, { inputs: [], engine_version: 2 }), 409, "engine_version");
    expect((await sql(`SELECT status, reject_reason FROM minigame_plays WHERE id = $1`, [t.play_id])).rows[0]).toEqual({
      status: "rejected",
      reject_reason: "engine_version",
    });
    const t2 = await issue(a, "free");
    await sql(`UPDATE minigame_plays SET engine_version = 0 WHERE id = $1`, [t2.play_id]);
    const e2 = m.mg.finishPlay(a, t2.play_id, { inputs: [], engine_version: 1 });
    await expect(e2).rejects.toMatchObject({ code: "engine_version", message: "ルール更新のため記録できません" });

    const t3 = await issue(a, "free");
    await age(t3.play_id, 31 * 60);
    await expectErr(m.mg.finishPlay(a, t3.play_id, { inputs: [], engine_version: 1 }), 409, "expired");

    const t4 = await issue(a, "free");
    await expectErr(m.mg.finishPlay(a, t4.play_id, { inputs: [1.5], engine_version: 1 }), 422, "invalid_record");
    await expectErr(m.mg.finishPlay(a, (await issue(a, "free")).play_id, { inputs: "x", engine_version: 1 }), 400, "invalid_request");
    await expectErr(m.mg.issuePlay(a, { mode: "x", character: "drikin" }), 400, "invalid_request");
    await expectErr(m.mg.issuePlay(a, { mode: "free", character: "someone" }), 400, "invalid_request");
  });

  it("順位表（今日・今週・通算・自分の順位）と、操作の記録は自己ベストの分だけ", async () => {
    // A は何もしない回（すぐ終わる）、B はうまい回
    const t1 = await issue(a, "daily");
    await age(t1.play_id, 30);
    const r1 = { ticket: t1, res: await m.mg.finishPlay(a, t1.play_id, { inputs: [], engine_version: 1 }) };
    const r2 = await playHonest(b, "daily", { lapse: 0, rngSeed: 2, character: "zenji" });
    expect(r2.res.score).toBeGreaterThan(r1.res.score);
    expect(r2.res.rank).toBe(1);
    // A の同じ点の回: ベストは変わらず（同点は先の回）、その回の記録は残さない
    const low = await m.mg.issuePlay(a, { mode: "daily", character: "drikin" });
    await age(low.play_id, 20);
    const lowRes = await m.mg.finishPlay(a, low.play_id, { inputs: [], engine_version: 1 });
    expect(lowRes.new_best).toBe(false);
    expect(lowRes.best).toBe(r1.res.score);
    expect(lowRes.rank).toBe(2);
    const kept = (await sql(`SELECT id FROM minigame_plays WHERE user_id = $1 AND inputs IS NOT NULL`, [a.userId])).rows.map((r) => r.id);
    expect(kept).toEqual([r1.ticket.play_id]);

    const today = await m.mg.getLeaderboard(a, "today", null);
    expect(today.entries.map((e) => [e.rank, e.name, e.score])).toEqual([
      [1, "みけ", r2.res.score],
      [2, "ねこ", r1.res.score],
    ]);
    expect(today.me).toEqual({ rank: 2, score: r1.res.score, distance: r1.res.distance });
    expect(JSON.stringify(today)).not.toMatch(/@/);

    // 自由プレイは今週・通算に載り、今日には載らない
    const f = await playHonest(a, "free", { lapse: 0, rngSeed: 5 });
    expect(f.res.period).toBe("week");
    expect(f.res.rank_today).toBeNull();
    const week = await m.mg.getLeaderboard(a, "week", null);
    expect(week.entries.map((e) => e.user_id)).toEqual([a.userId]);
    expect((await m.mg.getLeaderboard(a, "today", null)).entries.length).toBe(2);
    const all = await m.mg.getLeaderboard(a, "all", null);
    expect(all.entries.length).toBe(2);
    expect((await m.mg.getLeaderboard(a, "all", "free")).entries.map((e) => e.user_id)).toEqual([a.userId]);
    await expectErr(m.mg.getLeaderboard(a, "month", null), 400, "invalid_request");

    // 自己ベスト更新で前の回の記録は消える（今日のベストが新しい回に移ったら）
    const better = await playHonest(a, "daily", { lapse: 0, rngSeed: 9 });
    expect(better.res.new_best).toBe(true);
    const keptNow = (await sql(`SELECT id FROM minigame_plays WHERE user_id = $1 AND inputs IS NOT NULL ORDER BY id`, [a.userId])).rows.map((r) => r.id);
    expect(keptNow).not.toContain(r1.ticket.play_id);
    expect(keptNow).toContain(better.ticket.play_id);

    // 情報（GET me）
    const info = await m.mg.getInfo(a);
    expect(info.engine_version).toBe(1);
    expect(info.top_today?.user_id).toBeDefined();
    expect(info.best.today?.score).toBeGreaterThan(0);
    expect(info.plays_today).toBeGreaterThanOrEqual(4);
  });

  it("今日 20 回を超えた最初の 1 回だけ rest_hint", async () => {
    for (let i = 0; i < 20; i++) {
      await sql(
        `INSERT INTO minigame_plays (user_id, mode, seed, character, engine_version, status, finished_at, score, distance, ticks)
         VALUES ($1, 'free', 1, 'drikin', 1, 'verified', now(), 1, 1, 60)`,
        [a.userId]
      );
    }
    const t = await issue(a, "free");
    await age(t.play_id, 30);
    const r = await m.mg.finishPlay(a, t.play_id, { inputs: [], engine_version: 1 });
    expect(r).toMatchObject({ plays_today: 21, rest_hint: true });
    const t2 = await issue(a, "free");
    await age(t2.play_id, 30);
    expect((await m.mg.finishPlay(a, t2.play_id, { inputs: [], engine_version: 1 })).rest_hint).toBe(false);
  });

  it("配信: 今日の上位 10 は全員へ（まとめて 1 回）、ベストは本人だけ、メールは載らない", async () => {
    await playHonest(a, "daily", { lapse: 200, rngSeed: 1 });
    await playHonest(b, "daily", { lapse: 200, rngSeed: 4 });
    await new Promise((r) => setTimeout(r, 80));
    const tops = live.filter((e) => (e as { type: string }).type === "minigame") as { top: { user_id: string }[] }[];
    expect(tops.length).toBeGreaterThanOrEqual(1);
    expect(tops.at(-1)!.top.length).toBe(2);
    expect(JSON.stringify(tops)).not.toMatch(/@test\.local/);
    const bests = personal.filter((p) => (p.ev as { type: string }).type === "minigame");
    expect(bests.map((p) => p.to).sort()).toEqual([A, B].sort());
    expect(JSON.stringify(bests.map((p) => p.ev))).not.toMatch(/@/);
    // 変わっていなければ配らない
    live.length = 0;
    expect(await m.mg.broadcastTopNow()).toBe(false);
  });

  it("公開後だけ: チャットの 1 行（1 位交代・上位 5 位、10 分以内はまとめる、1 日 10 行）", async () => {
    // 公開前（メールの指定）は出さない
    process.env.MINIGAME_ENABLED = `${A},${B}`;
    const ti = await issue(a, "daily");
    await age(ti.play_id, 30);
    await m.mg.finishPlay(a, ti.play_id, { inputs: [], engine_version: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await sql(`SELECT count(*) AS n FROM chat_messages WHERE body LIKE '%締め切りダッシュ%'`)).rows[0].n).toBe("0");

    process.env.MINIGAME_ENABLED = "1";
    await playHonest(b, "daily", { lapse: 0, rngSeed: 2 }); // B が 1 位に（1 位交代）
    await new Promise((r) => setTimeout(r, 100));
    const rows = (await sql(`SELECT id, body, kind FROM chat_messages WHERE body LIKE '%締め切りダッシュ%' ORDER BY id`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("notice");
    expect(rows[0].body).toContain("みけさんが「締め切りダッシュ」今日の 1 位に！");

    // 10 分以内の続きは同じ行を書き換える、10 分を過ぎたら新しい行、1 日 10 行まで
    const base = Date.now();
    await m.mg.postAnnounce("🐶 テスト 締め切りダッシュ 1", base + 60_000);
    let n = (await sql(`SELECT count(*) AS n FROM chat_messages WHERE body LIKE '%締め切りダッシュ%'`)).rows[0].n;
    expect(n).toBe("1");
    expect((await sql(`SELECT body FROM chat_messages WHERE id = $1`, [rows[0].id])).rows[0].body).toBe("🐶 テスト 締め切りダッシュ 1");
    for (let i = 0; i < 15; i++) await m.mg.postAnnounce(`🐶 テスト 締め切りダッシュ ${i + 2}`, base + (i + 1) * 11 * 60_000);
    n = (await sql(`SELECT count(*) AS n FROM chat_messages WHERE body LIKE '%締め切りダッシュ%'`)).rows[0].n;
    expect(Number(n)).toBe(m.mg.ANNOUNCE_MAX_PER_DAY);
  });

  it("公開後だけ: 月曜 9 時の週の王者（ビーグル、1 本だけ）", async () => {
    const mon = Date.parse("2026-10-26T09:30:00+09:00"); // 月曜
    const prev = "2026-10-19";
    for (const [u, score] of [
      [a, 5000],
      [b, 7000],
    ] as const) {
      await sql(
        `INSERT INTO minigame_bests (game, board, user_id, play_id, score, distance, character, achieved_at) VALUES ('dash', $1, $2, 1, $3, $4, 'drikin', now())`,
        [`w:${prev}`, u.userId, score, score - 500]
      );
    }
    process.env.MINIGAME_ENABLED = `${A}`;
    expect(await m.mg.weeklyKingCheck(mon)).toBeNull(); // 公開前は出さない
    process.env.MINIGAME_ENABLED = "1";
    expect(await m.mg.weeklyKingCheck(Date.parse("2026-10-26T08:59:00+09:00"))).toBeNull(); // 9 時前
    const id = await m.mg.weeklyKingCheck(mon);
    expect(id).toBeGreaterThan(0);
    const post = (await sql(`SELECT author_name, text FROM posts WHERE id = $1`, [id])).rows[0];
    expect(post.author_name).toBe("ビーグル");
    expect(post.text).toContain("先週の「締め切りダッシュ」王者は みけさん！ 7,000 点");
    expect(await m.mg.weeklyKingCheck(mon + 60_000)).toBeNull(); // 二重に投稿しない
    await sql(`DELETE FROM posts WHERE id = $1`, [id]);
  });

  it("管理者: 記録を消すと順位表を作り直す、ほかの人は 403", async () => {
    const r1 = await playHonest(a, "daily", { lapse: 500, rngSeed: 1 });
    const r2 = await playHonest(a, "daily", { lapse: 0, rngSeed: 2 });
    await playHonest(b, "daily", { lapse: 300, rngSeed: 3 });
    const top = Math.max(r1.res.score, r2.res.score);
    const cur = await m.mg.bestOn(`d:${m.mg.dailyDate()}`, a.userId);
    expect(cur?.score).toBe(top);
    const bestId = cur!.play_id;
    const other = bestId === r2.ticket.play_id ? r1 : r2;

    const denied = await m.api.handleMinigame("POST", ["admin", "plays", String(bestId), "reject"], a, new URLSearchParams(), async () => ({}));
    expect(denied.status).toBe(403);
    const ok = await m.api.handleMinigame("POST", ["admin", "plays", String(bestId), "reject"], admin, new URLSearchParams(), async () => ({}));
    expect(ok.status).toBe(200);
    expect((await m.mg.bestOn(`d:${m.mg.dailyDate()}`, a.userId))?.score).toBe(other.res.score);
    const list = await m.api.handleMinigame("GET", ["admin", "plays"], admin, new URLSearchParams({ user_id: a.userId }), async () => ({}));
    expect((list.body as { plays: { id: number; status: string }[] }).plays.find((p) => p.id === bestId)?.status).toBe("rejected");

    const clr = await m.api.handleMinigame("POST", ["admin", "users", a.userId, "clear"], admin, new URLSearchParams(), async () => ({}));
    expect(clr.status).toBe(200);
    expect(await m.mg.bestOn(`d:${m.mg.dailyDate()}`, a.userId)).toBeNull();
    expect((await m.mg.getLeaderboard(b, "today", null)).entries.map((e) => e.user_id)).toEqual([b.userId]);
  });
});
