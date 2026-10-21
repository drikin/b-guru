/**
 * ☗ 将棋の DB を通した確認（lib/shogi.ts・lib/shogi-api.ts）。
 *
 * 本物の PostgreSQL が要る。事故を避けるため DATABASE_URL ではなく専用の
 * SHOGI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと。テーブルを作り、行を消す）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       SHOGI_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run shogi-db
 *
 *  - 端から端まで: 募集 → 受ける（振り駒）→ 数手 → 投了 → チャットのカード・ビーグルの投稿・配信
 *  - 同時の指し手: 手数違いは 409 と最新の状態、同じ client_move_id は二重に適用しない、同時に 2 手は 1 手だけ
 *  - 状態遷移: 期限切れ（募集・指名）・中断（60 秒）・時間切れ・放置・24 時間の通知・2 手目までの取り消し
 *  - 再起動をまたぐ: 起動時刻＋10 秒より前の期限を延ばす
 *  - 見える範囲: 指名は二人にだけ。配信にメールが載らない
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const URL_ = process.env.SHOGI_TEST_DATABASE_URL;
// 全員に公開した状態で試す（公開前はカード・ビーグルの投稿・通知を出さない。下の「自分との対局」で確かめる）。
process.env.SHOGI_ENABLED = "1";
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  shogi: typeof import("../shogi");
  api: typeof import("../shogi-api");
  live: typeof import("../live");
  personal: typeof import("../personal-live");
  user: typeof import("../user");
};
let m: Mods;
const A = `shogi-a-${Date.now()}@test.local`;
const B = `shogi-b-${Date.now()}@test.local`;
const C = `shogi-c-${Date.now()}@test.local`;
let a: { email: string; userId: string };
let b: { email: string; userId: string };
let c: { email: string; userId: string };
const live: unknown[] = [];
const personal: { to: string; ev: unknown }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

d("☗ 将棋（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      shogi: await import("../shogi"),
      api: await import("../shogi-api"),
      live: await import("../live"),
      personal: await import("../personal-live"),
      user: await import("../user"),
    };
    // 空の DB では initSchema が drinews_articles を作る前に参照して失敗する（既存の並び順）。先に作っておく。
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    a = { email: A, userId: await m.user.ensureUserId(A) };
    b = { email: B, userId: await m.user.ensureUserId(B) };
    c = { email: C, userId: await m.user.ensureUserId(C) };
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ドリキン'), ($2, 'ねこ'), ($3, 'みけ') ON CONFLICT DO NOTHING`, [A, B, C]);
    m.live.liveBus.on("change", (ev) => live.push(ev));
    for (const u of [a, b, c]) m.personal.personalBus.on(m.personal.personalKey(u.email), (ev) => personal.push({ to: u.email, ev }));
  });

  beforeEach(async () => {
    m.shogi._resetShogiForTest();
    live.length = 0;
    personal.length = 0;
    await sql(`DELETE FROM shogi_games`);
  });

  afterAll(async () => {
    if (!m) return;
    m.shogi._resetShogiForTest();
    await sql(`DELETE FROM shogi_games`);
    await m.db.pool.end();
  });

  const call = (actor: { email: string; userId: string }, method: string, path: string, body?: Record<string, unknown>, q = "") =>
    m.api.handleShogi(method, path.split("/").filter(Boolean), actor, new URLSearchParams(q), async () => body ?? null);
  const gameOf = (out: { status: number; body?: unknown }) => (out as { body: { game: Record<string, any> } }).body.game;

  async function startGame(mode: "blitz" | "slow" = "blitz") {
    const created = await call(a, "POST", "games", { mode });
    expect(created.status).toBe(201);
    const id = gameOf(created).id as number;
    const acc = await call(b, "POST", `games/${id}/accept`);
    expect(acc.status).toBe(200);
    const g = gameOf(acc);
    const black = g.black.user_id === a.userId ? a : b;
    const white = black === a ? b : a;
    return { id, black, white, game: g };
  }

  it("募集 → 受ける → 数手 → 投了: カード・ビーグルの投稿・配信", async () => {
    const { id, black, white, game } = await startGame("blitz");
    expect(game.status).toBe("active");
    expect([game.black.user_id, game.white.user_id].sort()).toEqual([a.userId, b.userId].sort());
    expect(game.clocks).toMatchObject({ black_ms: 600000, white_ms: 600000, byoyomi_ms: 30000 });

    // チャットの対局中カード（kind shogi、文字だけでも通じる文）
    const card = await sql(`SELECT * FROM chat_messages WHERE shogi_game_id = $1`, [id]);
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0].kind).toBe("shogi");
    expect(card.rows[0].body).toMatch(/^☗.+ vs ☖.+（⚡速い将棋）対局中/);

    const moves: [typeof a, string][] = [
      [black, "7g7f"],
      [white, "3c3d"],
      [black, "2g2f"],
    ];
    for (let i = 0; i < moves.length; i++) {
      const [who, usi] = moves[i];
      const r = await call(who, "POST", `games/${id}/move`, { usi, expected_ply: i, client_move_id: `cm-${i}` });
      expect(r.status).toBe(200);
      expect(gameOf(r).ply).toBe(i + 1);
    }
    const detail = gameOf(await call(c, "GET", `games/${id}`));
    expect(detail.moves.map((x: { label: string }) => x.label)).toEqual(["▲7六歩", "△3四歩", "▲2六歩"]);
    expect(detail.my_color).toBeNull();
    expect(detail.kif_url).toBe(`/api/shogi/games/${id}/kif`);

    const res = await call(white, "POST", `games/${id}/resign`);
    expect(res.status).toBe(200);
    const ended = gameOf(res);
    expect(ended).toMatchObject({ status: "ended", result: "black", end_reason: "resign", ply: 3 });
    expect(ended.result_post_id).toBeGreaterThan(0);

    // カードの本文は結果に書き換わる
    const card2 = await sql(`SELECT body FROM chat_messages WHERE id = $1`, [card.rows[0].id]);
    expect(card2.rows[0].body).toContain("さんの勝ち（投了・3 手）");

    // ビーグルの投稿（AI なしのテンプレート）
    const post = await sql(`SELECT author_email, author_name, text, parent_id, is_whisper FROM posts WHERE id = $1`, [ended.result_post_id]);
    expect(post.rows[0]).toMatchObject({ author_email: "system@backspace.fm", author_name: "ビーグル", parent_id: null, is_whisper: false });
    const text = post.rows[0].text as string;
    expect(text).toContain("☗ 将棋の対局が終わったわん");
    expect(text).toContain("投了・3 手");
    expect(text).toContain(`/#/shogi/${id}`);
    expect(text).toContain(`/api/shogi/games/${id}/kif`);
    expect(text).toMatch(/おめでとうだわん/);
    console.log("\n--- ビーグルの投稿 ---\n" + text + "\n---");

    // KIF
    const kif = await call(c, "GET", `games/${id}/kif`);
    expect("text" in kif && kif.text).toContain("投了");

    // 配信: state（受ける・指し手）と end。メールは載らない
    const shogiEvents = live.filter((e) => (e as { type: string }).type === "shogi") as { action: string; game: Record<string, unknown> }[];
    expect(shogiEvents.map((e) => e.action)).toEqual(["state", "state", "state", "state", "state", "end"]);
    expect(Object.keys(shogiEvents[0].game).sort()).toEqual(
      [
        "id", "status", "mode", "creator", "invitee", "black", "white", "sfen", "ply", "turn", "last_move", "clocks",
        "turn_started_at", "deadline_at", "server_now", "spectators", "result", "end_reason", "created_at", "started_at",
        "ended_at", "rematch_of", "card_message_id", "result_post_id",
      ].sort()
    );
    expect(JSON.stringify(live)).not.toContain("@test.local");
    // チャットのカードの配信（create と、終局の edit）
    const chat = live.filter((e) => (e as { type: string }).type === "chat") as { action: string; message: { kind?: string; shogiGameId?: number } }[];
    expect(chat.map((e) => [e.action, e.message.kind, e.message.shogiGameId])).toEqual([
      ["create", "shogi", id],
      ["edit", "shogi", id],
    ]);
    // タイムラインへの投稿の配信
    expect(live.some((e) => (e as { type: string; postId?: number }).type === "post" && (e as { postId: number }).postId === ended.result_post_id)).toBe(true);
  });

  it("自分との対局（テスト用、公開前）: 自分で受けて両方の手を指せる・カードも投稿も出さない", async () => {
    process.env.SHOGI_ENABLED = A;
    process.env.SHOGI_SELF_PLAY = A;
    try {
      const created = await call(a, "POST", "games", { mode: "blitz" });
      const id = gameOf(created).id as number;
      const acc = await call(a, "POST", `games/${id}/accept`);
      expect(acc.status).toBe(200);
      expect(gameOf(acc).black.user_id).toBe(a.userId);
      expect(gameOf(acc).white.user_id).toBe(a.userId);
      expect(gameOf(await call(a, "GET", `games/${id}`)).my_color).toBe("black");
      expect((await call(a, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 })).status).toBe(200);
      expect(gameOf(await call(a, "GET", `games/${id}`)).my_color).toBe("white");
      expect((await call(a, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 })).status).toBe(200);
      const ended = gameOf(await call(a, "POST", `games/${id}/resign`));
      expect(ended.status).toBe("ended");
      expect((await sql(`SELECT 1 FROM chat_messages WHERE shogi_game_id = $1`, [id])).rows).toHaveLength(0);
      expect(ended.result_post_id ?? null).toBeNull();
      // 名簿にない人は自分の募集を受けられない
      process.env.SHOGI_SELF_PLAY = "";
      const g2 = gameOf(await call(a, "POST", "games", { mode: "slow" })).id as number;
      expect((await call(a, "POST", `games/${g2}/accept`)).status).toBe(400);
    } finally {
      process.env.SHOGI_ENABLED = "1";
      delete process.env.SHOGI_SELF_PLAY;
    }
  });

  it("手数が違えば 409 と最新の状態、同じ client_move_id は二重に適用しない", async () => {
    const { id, black, white } = await startGame();
    const r1 = await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0, client_move_id: "same-1" });
    expect(r1.status).toBe(200);
    // 返事が届かなかったつもりで同じ client_move_id を再送 → 200・duplicate・手数は 1 のまま
    const again = await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0, client_move_id: "same-1" });
    expect(again.status).toBe(200);
    expect((again as { body: { duplicate: boolean } }).body.duplicate).toBe(true);
    expect(gameOf(again).ply).toBe(1);
    const rows = await sql(`SELECT count(*)::int AS n FROM shogi_moves WHERE game_id = $1`, [id]);
    expect(rows.rows[0].n).toBe(1);
    // 古い手数で指す → 409 と最新の game
    const stale = await call(white, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 0, client_move_id: "w-1" });
    expect(stale.status).toBe(409);
    expect((stale as { body: { code: string } }).body.code).toBe("conflict");
    expect(gameOf(stale).ply).toBe(1);
    // 相手の番に指す → 409
    const notMine = await call(black, "POST", `games/${id}/move`, { usi: "2g2f", expected_ply: 1, client_move_id: "b-2" });
    expect(notMine.status).toBe(409);
    expect((notMine as { body: { code: string } }).body.code).toBe("not_your_turn");
    // 反則 → 400
    const illegal = await call(white, "POST", `games/${id}/move`, { usi: "3c3e", expected_ply: 1, client_move_id: "w-2" });
    expect(illegal.status).toBe(400);
    expect((illegal as { body: { code: string } }).body.code).toBe("illegal_move");
    // 観戦者は指せない
    const outsider = await call(c, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 });
    expect(outsider.status).toBe(403);
  });

  it("同時に 2 つの手が来ても 1 手だけ（もう一方は 409）", async () => {
    const { id, black } = await startGame();
    const [x, y] = await Promise.all([
      call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0, client_move_id: "p-1" }),
      call(black, "POST", `games/${id}/move`, { usi: "2g2f", expected_ply: 0, client_move_id: "p-2" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const rows = await sql(`SELECT usi FROM shogi_moves WHERE game_id = $1`, [id]);
    expect(rows.rows).toHaveLength(1);
  });

  it("募集は 15 分・指名は 24 時間で期限切れ（読み取りのたびにその場で）", async () => {
    const open = gameOf(await call(a, "POST", "games", { mode: "blitz" }));
    await sql(`UPDATE shogi_games SET created_at = now() - interval '16 minutes' WHERE id = $1`, [open.id]);
    const list0 = (await call(b, "GET", "games")) as { body: { games: { id: number }[] } };
    expect(list0.body.games.find((g) => g.id === open.id)).toBeUndefined(); // closed は一覧に出さない
    const st = await sql(`SELECT status, end_reason FROM shogi_games WHERE id = $1`, [open.id]);
    expect(st.rows[0]).toEqual({ status: "closed", end_reason: "expired" });
    // 期限切れの募集は片付いているので、次の申し込みを出せる
    const offer = gameOf(await call(a, "POST", "games", { mode: "slow", invitee_user_id: b.userId }));
    // 指名は相手にだけ届く（offer）・ほかの人には見えない
    expect(personal.filter((p) => p.to === B && (p.ev as { action: string }).action === "offer")).toHaveLength(1);
    expect((await call(c, "GET", `games/${offer.id}`)).status).toBe(404);
    const listC = (await call(c, "GET", "games")) as { body: { games: { id: number }[] } };
    expect(listC.body.games.map((g) => g.id)).not.toContain(offer.id);
    await sql(`UPDATE shogi_games SET created_at = now() - interval '23 hours' WHERE id = $1`, [offer.id]);
    const list = (await call(b, "GET", "games")) as { body: { games: { id: number; status: string }[] } };
    expect(list.body.games.find((g) => g.id === offer.id)?.status).toBe("offered");
    // 期限切れの申し込みは受けられない
    await sql(`UPDATE shogi_games SET created_at = now() - interval '25 hours' WHERE id = $1`, [offer.id]);
    const late = await call(b, "POST", `games/${offer.id}/accept`);
    expect(late.status).toBe(409);
  });

  it("対局はサイト全体で 1 つだけ・受けるのは早い者勝ち", async () => {
    const open = gameOf(await call(a, "POST", "games", { mode: "blitz" }));
    // 募集があるあいだは、ほかの人も同じ人も新しく出せない（今ある対局が返る）
    const busy = await call(b, "POST", "games", { mode: "slow" });
    expect(busy.status).toBe(409);
    expect((busy as { body: { code: string; game: { id: number } } }).body.code).toBe("busy");
    expect((busy as { body: { game: { id: number } } }).body.game.id).toBe(open.id);
    // 2 人が同時に受けても対局者は 1 人
    const [r1, r2] = await Promise.all([call(b, "POST", `games/${open.id}/accept`), call(c, "POST", `games/${open.id}/accept`)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    // 対局中も新しく出せない
    expect((await call(c, "POST", "games", { mode: "blitz" })).status).toBe(409);
    // 2 人が同時に募集しても 1 つだけ（終局後）
    const winner = r1.status === 200 ? b : c;
    await call(winner, "POST", `games/${open.id}/resign`);
    const [n1, n2] = await Promise.all([call(b, "POST", "games", { mode: "blitz" }), call(c, "POST", "games", { mode: "blitz" })]);
    expect([n1.status, n2.status].sort()).toEqual([201, 409]);
  });

  it("速い将棋で双方が 1 手目を指す前に 60 秒たったら中断（勝敗なし・投稿なし）", async () => {
    const { id, black } = await startGame();
    await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 });
    await sql(`UPDATE shogi_games SET turn_started_at = now() - interval '62 seconds' WHERE id = $1`, [id]);
    const g = gameOf(await call(c, "GET", `games/${id}`));
    expect(g).toMatchObject({ status: "ended", result: null, end_reason: "aborted", result_post_id: null });
  });

  it("時間切れ（その場の判定）: 時間切れの側が指そうとしても採らず、相手の勝ち", async () => {
    const { id, black, white } = await startGame();
    await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 });
    await call(white, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 });
    // 先手の持ち時間 5 秒・手番が始まってから 40 秒（＞ 5 + 30 + 1）
    await sql(`UPDATE shogi_games SET clock_b_ms = 5000, turn_started_at = now() - interval '40 seconds' WHERE id = $1`, [id]);
    const r = await call(black, "POST", `games/${id}/move`, { usi: "2g2f", expected_ply: 2 });
    expect(r.status).toBe(409);
    expect(gameOf(r)).toMatchObject({ status: "ended", result: "white", end_reason: "timeout", ply: 2 });
  });

  it("秒読みの中なら指せる（持ち時間は 0 のまま）", async () => {
    const { id, black, white } = await startGame();
    await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 });
    await call(white, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 });
    await sql(`UPDATE shogi_games SET clock_b_ms = 5000, turn_started_at = now() - interval '20 seconds' WHERE id = $1`, [id]);
    const r = await call(black, "POST", `games/${id}/move`, { usi: "2g2f", expected_ply: 2 });
    expect(r.status).toBe(200);
    expect(gameOf(r).clocks.black_ms).toBe(0);
  });

  it("タイマー: 期限が来たら resolveDue が終局させる", async () => {
    const { id, black, white } = await startGame();
    await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 });
    await call(white, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 });
    await sql(`UPDATE shogi_games SET clock_b_ms = 0, turn_started_at = now() - interval '32 seconds' WHERE id = $1`, [id]);
    const row = await m.shogi.resolveDue(id);
    expect(row).toMatchObject({ status: "ended", result: "white", end_reason: "timeout" });
    expect(live.some((e) => (e as { type: string; action: string }).type === "shogi" && (e as { action: string }).action === "end")).toBe(true);
  });

  it("ゆっくり: 24 時間で一度通知（reminded_at）、72 時間で放置負け", async () => {
    const { id } = await startGame("slow");
    await sql(`UPDATE shogi_games SET turn_started_at = now() - interval '25 hours' WHERE id = $1`, [id]);
    const r1 = await m.shogi.resolveDue(id);
    expect(r1?.status).toBe("active");
    expect(r1?.reminded_at).not.toBeNull();
    await sql(`UPDATE shogi_games SET turn_started_at = now() - interval '73 hours' WHERE id = $1`, [id]);
    const g = gameOf(await call(a, "GET", `games/${id}`));
    expect(g).toMatchObject({ status: "ended", result: "white", end_reason: "abandon" });
  });

  it("2 手目までは取り消せる（中断）、そのあとは投了だけ", async () => {
    const one = await startGame();
    const r = await call(one.white, "POST", `games/${one.id}/cancel`);
    expect(gameOf(r)).toMatchObject({ status: "ended", end_reason: "aborted", result: null });
    const two = await startGame();
    await call(two.black, "POST", `games/${two.id}/move`, { usi: "7g7f", expected_ply: 0 });
    await call(two.white, "POST", `games/${two.id}/move`, { usi: "3c3d", expected_ply: 1 });
    const late = await call(two.black, "POST", `games/${two.id}/cancel`);
    expect(late.status).toBe(409);
  });

  it("再戦は先後を入れ替える", async () => {
    const first = await startGame();
    await call(first.black, "POST", `games/${first.id}/resign`);
    const re = await call(first.black, "POST", "games", { mode: "blitz", rematch_of: first.id });
    expect(re.status).toBe(201);
    const offered = gameOf(re);
    expect(offered.invitee.user_id).toBe(first.white.userId);
    const acc = gameOf(await call(first.white, "POST", `games/${offered.id}/accept`));
    expect(acc.black.user_id).toBe(first.white.userId);
    expect(acc.white.user_id).toBe(first.black.userId);
  });

  it("再起動をまたぐ: 起動時刻＋10 秒より前の期限を延ばしてから判定する", async () => {
    const { id, black, white } = await startGame();
    await call(black, "POST", `games/${id}/move`, { usi: "7g7f", expected_ply: 0 });
    await call(white, "POST", `games/${id}/move`, { usi: "3c3d", expected_ply: 1 });
    // サーバが止まっている間に期限（残り 0 秒＋秒読み 30 秒）を過ぎた
    await sql(`UPDATE shogi_games SET clock_b_ms = 0, turn_started_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    m.shogi._resetShogiForTest();
    await m.shogi.shogiReady();
    const g = gameOf(await call(c, "GET", `games/${id}`));
    // このテストのプロセスは起動して 10 秒以上たっていることがあるので、延ばした結果だけを見る:
    // 期限 = 起動時刻＋10 秒（＝延ばされた）。時間切れにはなっていてもよいが、延ばす前の期限ではない。
    const deadline = Date.parse(g.deadline_at ?? g.ended_at);
    const boot = Date.now() - Math.round(process.uptime() * 1000);
    if (g.status === "active") expect(Math.abs(deadline - (boot + 10_000))).toBeLessThan(1500);
    const ts = await sql(`SELECT turn_started_at FROM shogi_games WHERE id = $1`, [id]);
    expect(new Date(ts.rows[0].turn_started_at).getTime()).toBeGreaterThan(Date.now() - 9 * 60_000);
  });

  it("一覧・存在しない道は 404", async () => {
    expect((await call(a, "GET", "nope")).status).toBe(404);
    expect((await call(a, "GET", "games/abc")).status).toBe(404);
    expect((await call(a, "POST", "games/999999/accept")).status).toBe(404);
    expect((await call(a, "POST", "games", { mode: "rapid" })).status).toBe(400);
    expect((await call(a, "POST", "games", { mode: "blitz", invitee_user_id: a.userId })).status).toBe(400);
  });
});
