/**
 * ☗ ビーグルの実況を DB を通して確かめる（lib/shogi-commentary.ts・shogi-commentary-store.ts）。AI はモック（外に出ない）。
 *
 * 本物の PostgreSQL が要る（shogi-db.test.ts と同じ SHOGI_TEST_DATABASE_URL。使い捨ての DB を指すこと）。
 * 並んで走る shogi-db.test.ts と行を消し合わないよう、同じサーバの別のデータベース（bguru_shogi_commentary_test）を作って使う。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       SHOGI_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run shogi-commentary-db
 *
 *  - 指し手 → 実況（AI の文）を保存・配信。見られるのは SHOGI_COMMENTARY_ENABLED の人だけ（GET games/{id}）
 *  - AI が空・失敗・事実と矛盾 → ひな形。AI が返事をしなければタイムアウトでひな形
 *  - 指し手の処理は AI を待たない。次の手が来たら古い方は捨てる（最新だけ）
 *  - 公開後: 見どころ（形勢逆転）だけチャットへ、1 局 2 件まで・4 分あける。1 手ずつは流れない。終局投稿に「分かれ目」
 *  - 公開前（オーナーだけ）: チャット・終局投稿に出さない
 *  - ビーグル戦: ビーグルが考えている間は待ち、最新の手に実況が付く
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";

const BASE_URL_ = process.env.SHOGI_TEST_DATABASE_URL;
const DB_NAME = "bguru_shogi_commentary_test";
process.env.SHOGI_ENABLED = "1";
const OWNER = `cmt-a-${Date.now()}@test.local`;
process.env.SHOGI_COMMENTARY_ENABLED = OWNER; // まずオーナーだけ（公開前）
const URL_ = BASE_URL_ ? BASE_URL_.replace(/\/[^/?]*(\?|$)/, `/${DB_NAME}$1`) : undefined;
if (URL_) process.env.DATABASE_URL = URL_;
const d = BASE_URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  shogi: typeof import("../shogi");
  api: typeof import("../shogi-api");
  live: typeof import("../live");
  user: typeof import("../user");
  beagle: typeof import("../shogi-beagle");
  cmt: typeof import("../shogi-commentary");
  store: typeof import("../shogi-commentary-store");
};
let m: Mods;
const B = `cmt-b-${Date.now()}@test.local`;
const C = `cmt-c-${Date.now()}@test.local`;
let a: { email: string; userId: string };
let b: { email: string; userId: string };
let c: { email: string; userId: string };
const live: { type: string; [k: string]: unknown }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

d("☗ ビーグルの実況（DB）", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE_URL_ });
    await admin.connect();
    const ex = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]);
    if (ex.rows.length === 0) await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    m = {
      db: await import("../db"),
      shogi: await import("../shogi"),
      api: await import("../shogi-api"),
      live: await import("../live"),
      user: await import("../user"),
      beagle: await import("../shogi-beagle"),
      cmt: await import("../shogi-commentary"),
      store: await import("../shogi-commentary-store"),
    };
    m.beagle._setBeagleDelayForTest(0);
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    a = { email: OWNER, userId: await m.user.ensureUserId(OWNER) };
    b = { email: B, userId: await m.user.ensureUserId(B) };
    c = { email: C, userId: await m.user.ensureUserId(C) };
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ドリキン'), ($2, 'ねこ') ON CONFLICT DO NOTHING`, [OWNER, B]);
    m.live.liveBus.on("change", (ev) => live.push(ev));
  });

  beforeEach(async () => {
    await m.cmt.commentaryIdle();
    m.shogi._resetShogiForTest();
    m.cmt._resetCommentaryForTest();
    process.env.SHOGI_COMMENTARY_ENABLED = OWNER;
    delete process.env.SHOGI_COMMENTARY_DAILY_AI;
    live.length = 0;
    await sql(`DELETE FROM shogi_games`);
    await sql(`DELETE FROM chat_messages`);
  });

  afterAll(async () => {
    if (!m) return;
    await m.cmt.commentaryIdle();
    await m.shogi._beagleSettledForTest();
    m.shogi._resetShogiForTest();
    await sql(`DELETE FROM shogi_games`);
    await m.db.pool.end();
  });

  const call = (actor: { email: string; userId: string }, method: string, path: string, body?: Record<string, unknown>) =>
    m.api.handleShogi(method, path.split("/").filter(Boolean), actor, new URLSearchParams(), async () => body ?? null);
  const gameOf = (out: { status: number; body?: unknown }) => (out as { body: { game: Record<string, any> } }).body.game; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** 実況の依頼（指し手のあと別の流れで入る）がすべて終わるまで。 */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await m.shogi._beagleSettledForTest();
      await m.cmt.commentaryIdle();
    }
  };

  async function startGame() {
    const created = await call(a, "POST", "games", { mode: "blitz" });
    const id = gameOf(created).id as number;
    const g = gameOf(await call(b, "POST", `games/${id}/accept`));
    const black = g.black.user_id === a.userId ? a : b;
    const white = black === a ? b : a;
    return { id, black, white };
  }

  async function play(id: number, who: { email: string; userId: string }, usi: string, ply: number) {
    const r = await call(who, "POST", `games/${id}/move`, { usi, expected_ply: ply, client_move_id: `c-${id}-${ply}` });
    expect(r.status).toBe(200);
    return r;
  }

  const rows = async (id: number) => (await sql(`SELECT * FROM shogi_commentary WHERE game_id = $1 ORDER BY ply`, [id])).rows;
  const notices = async () => (await sql(`SELECT body FROM chat_messages WHERE kind = 'notice' AND body LIKE '%ビーグルの実況%' ORDER BY id`)).rows;

  it("指し手 → AI の実況を保存・配信。見られるのはオーナーだけ（公開前はチャットに出さない）", async () => {
    const prompts: string[] = [];
    m.cmt._setCommentaryAiForTest(async (msgs) => {
      prompts.push(msgs[1].content);
      return "角道を開けたわん！形勢は互角だわん";
    });
    const { id, black, white } = await startGame();
    await play(id, black, "7g7f", 0);
    await settle();
    const r1 = await rows(id);
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ ply: 1, move_label: "▲7六歩", text: "角道を開けたわん！形勢は互角だわん", source: "ai" });
    expect(typeof r1[0].eval_cp).toBe("number");
    expect(r1[0].best_label).toMatch(/^△/); // 次の予想手は後手の手
    expect(prompts[0]).toContain("1 手目: ☗先手の ▲7六歩");
    expect(prompts[0]).not.toContain("ドリキン"); // 名前は AI に渡さない
    expect(prompts[0]).not.toContain("ねこ");
    // 配信: shogi_commentary（メールは載せない）
    // 配信: まずひな形（帯が毎手必ず更新される）→ AI の文が検査を通ったら同じ手を置き換えて配り直す
    const evs = live.filter((e) => e.type === "shogi_commentary") as unknown as { gameId: number; commentary: Record<string, unknown> }[];
    expect(evs.map((e) => e.commentary.source)).toEqual(["template", "ai"]);
    const ev = evs.at(-1);
    expect(ev?.gameId).toBe(id);
    expect(ev?.commentary).toMatchObject({ game_id: id, ply: 1, source: "ai", text: "角道を開けたわん！形勢は互角だわん" });
    expect(JSON.stringify(ev)).not.toContain("@test.local");
    // 途中から開いた人: オーナーには最新の実況、ほかの人には付かない
    const ga = gameOf(await call(a, "GET", `games/${id}`));
    expect(ga.commentary).toMatchObject({ ply: 1, text: "角道を開けたわん！形勢は互角だわん" });
    const gb = gameOf(await call(b, "GET", `games/${id}`));
    expect(gb).not.toHaveProperty("commentary");
    expect(m.store.commentaryEnabledFor(a.email)).toBe(true);
    expect(m.store.commentaryEnabledFor(b.email)).toBe(false);
    // 2 手目も（前の手の評価・最善手を引き継ぐ）
    await play(id, white, "3c3d", 1);
    await settle();
    expect((await rows(id)).map((x) => x.ply)).toEqual([1, 2]);
    expect(prompts[1]).toContain("ひとつ前の手: ▲7六歩");
    // 公開前: チャットに出さない
    expect(await notices()).toHaveLength(0);
  });

  it("AI が空・失敗・事実と矛盾・返事なし（タイムアウト）→ ひな形で必ず埋める", async () => {
    const answers: (() => Promise<string>)[] = [
      async () => "", // Qwen がときどき返す空
      async () => {
        throw new Error("503");
      },
      async () => "次は5五角だわん", // 事実にない手
    ];
    let i = 0;
    m.cmt._setCommentaryAiForTest(
      (_msgs, signal) =>
        answers[i++]?.() ??
        new Promise<string>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))), // 返事なし
      150
    );
    const { id, black, white } = await startGame();
    const seq: [typeof a, string][] = [
      [black, "7g7f"],
      [white, "3c3d"],
      [black, "2g2f"],
      [white, "8c8d"],
    ];
    for (let p = 0; p < seq.length; p++) {
      await play(id, seq[p][0], seq[p][1], p);
      await settle();
    }
    const r = await rows(id);
    expect(r.map((x) => x.ply)).toEqual([1, 2, 3, 4]);
    for (const x of r) {
      expect(x.source).toBe("template");
      expect(x.text).toContain(x.move_label);
      expect(x.text).toContain("わん");
    }
  });

  it("指し手は AI を待たない。次の手が来たら古い方は捨てる（最新だけ・同時 1）", async () => {
    let inflight = 0;
    let maxInflight = 0;
    let calls = 0;
    m.cmt._setCommentaryAiForTest(async (_msgs, signal) => {
      calls++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        // 400ms かかる AI（打ち切られたらすぐ戻る）
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 400);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            rej(new Error("aborted"));
          });
        });
        return "いい勝負だわん";
      } finally {
        inflight--;
      }
    });
    const { id, black, white } = await startGame();
    const t0 = Date.now();
    await play(id, black, "7g7f", 0);
    await new Promise((r) => setTimeout(r, 150)); // 1 手目の実況が AI を待っている間に
    await play(id, white, "3c3d", 1);
    await play(id, black, "2g2f", 2);
    const spent = Date.now() - t0;
    expect(spent).toBeLessThan(400 + 150); // 指し手の処理は AI（400ms）を待っていない
    await settle();
    const r = await rows(id);
    // 1 手目: ひな形は先に出た・AI は打ち切られた。2 手目: 待っている間に 3 手目が来て捨てられた。3 手目: AI の文に置き換わった
    expect(r.map((x) => x.ply)).toEqual([1, 3]);
    expect(r[0]).toMatchObject({ ply: 1, source: "template" });
    expect(r[1]).toMatchObject({ ply: 3, source: "ai", text: "いい勝負だわん" });
    expect(maxInflight).toBe(1);
    expect(calls).toBe(2);
    expect(m.cmt._commentaryStatsForTest().dropped).toBeGreaterThanOrEqual(2);
    // 配信: 1 手目のひな形 → 3 手目のひな形 → 3 手目の AI の文（同じ手を置き換え）
    expect(live.filter((e) => e.type === "shogi_commentary").map((e) => `${(e.commentary as { ply: number }).ply}:${(e.commentary as { source: string }).source}`)).toEqual([
      "1:template",
      "3:template",
      "3:ai",
    ]);
  });

  it("公開後: 見どころ（形勢逆転）だけチャットへ・1 局 2 件まで・4 分あける。1 手ずつは流れない。終局投稿に分かれ目", async () => {
    process.env.SHOGI_COMMENTARY_ENABLED = "1";
    m.cmt._setCommentaryAiForTest(async () => "いい勝負だわん");
    const { id, black, white } = await startGame();
    const seq: [typeof a, string][] = [
      [black, "7g7f"],
      [white, "3c3d"],
      [black, "2g2f"],
    ];
    for (let p = 0; p < seq.length; p++) {
      await play(id, seq[p][0], seq[p][1], p);
      await settle();
    }
    expect(await notices()).toHaveLength(0); // ふつうの手はチャットに出ない
    // 3 手目の評価を後手大優勢にしておき、4 手目 △5五角?? (角をただで取られる) で形勢逆転にする
    await sql(`UPDATE shogi_commentary SET eval_cp = -1000 WHERE game_id = $1 AND ply = 3`, [id]);
    await play(id, white, "2b5e", 3);
    await settle();
    const r4 = (await rows(id)).find((x) => x.ply === 4);
    expect(r4.highlight).toBe("reversal");
    expect(r4.eval_cp).toBeGreaterThanOrEqual(400);
    const n = await notices();
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/^🐶 ビーグルの実況（☗.+ vs ☖.+・4 手目）いい勝負だわん$/);

    // すぐ次の見どころ: 4 分たっていないので出さない
    await sql(`UPDATE shogi_commentary SET eval_cp = -1000 WHERE game_id = $1 AND ply = 4`, [id]);
    await play(id, black, "8h5e", 4); // ▲5五角（角を取る）
    await settle();
    expect((await rows(id)).find((x) => x.ply === 5)?.highlight).toBe("reversal");
    expect(await notices()).toHaveLength(1);

    // 4 分たった: 2 件目
    await sql(`UPDATE shogi_games SET commentary_chat_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    await sql(`UPDATE shogi_commentary SET eval_cp = -1000 WHERE game_id = $1 AND ply = 5`, [id]);
    await play(id, white, "4a3b", 5);
    await settle();
    expect(await notices()).toHaveLength(2);

    // 2 件まで（終局はカード・投稿で 3 件目）
    await sql(`UPDATE shogi_games SET commentary_chat_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    await sql(`UPDATE shogi_commentary SET eval_cp = -1000 WHERE game_id = $1 AND ply = 6`, [id]);
    await play(id, black, "5e1a+", 6);
    await settle();
    expect((await rows(id)).find((x) => x.ply === 7)?.highlight).toBe("reversal");
    expect(await notices()).toHaveLength(2);
    // 7 手指して、チャットに出た実況は 2 件だけ（1 手ずつは流れない）
    expect((await rows(id)).length).toBe(7);

    // 投了 → 終局のまとめ（ひな形）と、終局投稿の「分かれ目」
    const res = gameOf(await call(white, "POST", `games/${id}/resign`));
    await settle();
    const last = (await rows(id)).at(-1);
    expect(last).toMatchObject({ ply: 7, source: "template" });
    expect(last.text).toContain("投了");
    const post = await sql(`SELECT text FROM posts WHERE id = $1`, [res.result_post_id]);
    expect(post.rows[0].text).toContain("ビーグルが見た分かれ目だわん:");
    // （上で評価を書き換えているので中身は問わない。2〜3 手・手数の順）
    const pts = (post.rows[0].text as string).split("\n").filter((l) => l.startsWith("📍 "));
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts.length).toBeLessThanOrEqual(3);
    // 再読み込み: 終局後は手ごとの実況が棋譜と一緒に
    const det = gameOf(await call(b, "GET", `games/${id}`));
    expect(det.commentaries.map((c: { ply: number }) => c.ply)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(det.commentary.ply).toBe(7);
    // 終局後は見どころをチャットに出さない
    expect(await notices()).toHaveLength(2);
  });

  it("公開前は終局投稿に分かれ目を出さない", async () => {
    m.cmt._setCommentaryAiForTest(async () => "いい勝負だわん");
    const { id, black, white } = await startGame();
    await play(id, black, "7g7f", 0);
    await play(id, white, "3c3d", 1);
    await settle();
    const res = gameOf(await call(black, "POST", `games/${id}/resign`));
    const post = await sql(`SELECT text FROM posts WHERE id = $1`, [res.result_post_id]);
    expect(post.rows[0].text).not.toContain("分かれ目");
  });

  it("SHOGI_COMMENTARY_ENABLED が未設定なら作らない（AI も呼ばない）", async () => {
    delete process.env.SHOGI_COMMENTARY_ENABLED;
    let calls = 0;
    m.cmt._setCommentaryAiForTest(async () => {
      calls++;
      return "いい勝負だわん";
    });
    const { id, black } = await startGame();
    await play(id, black, "7g7f", 0);
    await settle();
    expect(await rows(id)).toHaveLength(0);
    expect(calls).toBe(0);
    expect(gameOf(await call(a, "GET", `games/${id}`))).not.toHaveProperty("commentary");
  });

  it("ビーグル戦: ビーグルが考えている間は探索をぶつけず、最新の手に実況が付く", async () => {
    m.cmt._setCommentaryAiForTest(async () => "いい勝負だわん");
    const created = await call(a, "POST", "games", { mode: "blitz", opponent: "beagle" });
    const id = gameOf(created).id as number;
    await settle();
    let g = gameOf(await call(a, "GET", `games/${id}`));
    for (let i = 0; i < 2; i++) {
      const usi = (await import("../shogi-rules")).legalUsi(g.sfen).find((u) => !u.includes("*"))!;
      await play(id, a, usi, g.ply);
      await settle();
      g = gameOf(await call(a, "GET", `games/${id}`));
    }
    const r = await rows(id);
    expect(r.length).toBeGreaterThan(0);
    expect(r.at(-1).ply).toBe(g.ply); // ビーグルの手（最新）に実況
    expect(g.commentary.ply).toBe(g.ply);
  });
  it("公開前: 見せる人（オーナー）が対局者でも観戦中でもない対局は AI を呼ばない（ひな形だけ）。観戦を始めたら呼ぶ", async () => {
    let calls = 0;
    m.cmt._setCommentaryAiForTest(async () => {
      calls++;
      return "いい勝負だわん";
    });
    const created = await call(b, "POST", "games", { mode: "slow" });
    const id = gameOf(created).id as number;
    const g = gameOf(await call(c, "POST", `games/${id}/accept`));
    const black = g.black.user_id === b.userId ? b : c;
    const white = black === b ? c : b;
    await play(id, black, "7g7f", 0);
    await settle();
    expect(calls).toBe(0);
    expect((await rows(id))[0]).toMatchObject({ ply: 1, source: "template" });
    // オーナーが盤を開いた（観戦の合図）
    await call(a, "POST", `games/${id}/watch`);
    await play(id, white, "3c3d", 1);
    await settle();
    expect(calls).toBe(1);
    expect((await rows(id))[1]).toMatchObject({ ply: 2, source: "ai" });
  });

  it("費用の上限: 1 日の AI 呼び出し数（SHOGI_COMMENTARY_DAILY_AI）", async () => {
    process.env.SHOGI_COMMENTARY_DAILY_AI = "1";
    let calls = 0;
    m.cmt._setCommentaryAiForTest(async () => {
      calls++;
      return "いい勝負だわん";
    });
    const { id, black, white } = await startGame();
    await play(id, black, "7g7f", 0);
    await settle();
    await play(id, white, "3c3d", 1);
    await settle();
    expect(calls).toBe(1);
    expect((await rows(id)).map((x) => x.source)).toEqual(["ai", "template"]);
  });

  it("費用の上限: 連続 5 回失敗したら 10 分 AI を止めてひな形だけ", async () => {
    let calls = 0;
    m.cmt._setCommentaryAiForTest(async () => {
      calls++;
      throw new Error("さくらのAI Engine error 429: too many requests");
    });
    const { id, black, white } = await startGame();
    const seq: [typeof a, string][] = [
      [black, "7g7f"],
      [white, "3c3d"],
      [black, "2g2f"],
      [white, "8c8d"],
      [black, "2f2e"],
      [white, "8d8e"],
      [black, "6i7h"],
    ];
    for (let p = 0; p < seq.length; p++) {
      await play(id, seq[p][0], seq[p][1], p);
      await settle();
    }
    expect(calls).toBe(5);
    expect(m.cmt._commentaryStatsForTest().breakerUntil).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await rows(id)).every((x) => x.source === "template")).toBe(true);
    expect(await rows(id)).toHaveLength(7);
  });

  it("見どころは終局のあとに割り込まない（投稿の直前に対局の行をロックして確かめる）", async () => {
    process.env.SHOGI_COMMENTARY_ENABLED = "1";
    const { id, black } = await startGame();
    await call(black, "POST", `games/${id}/resign`);
    expect(await m.store.postHighlightIfActive(id, "🐶 ビーグルの実況（テスト）だわん")).toBe(false);
    expect(await notices()).toHaveLength(0);
    // 対局中なら 1 件だけ・すぐ次は出さない
    const g2 = await startGame();
    expect(await m.store.postHighlightIfActive(g2.id, "🐶 ビーグルの実況（テスト）1 だわん")).toBe(true);
    expect(await m.store.postHighlightIfActive(g2.id, "🐶 ビーグルの実況（テスト）2 だわん")).toBe(false);
    expect(await notices()).toHaveLength(1);
  });
});
