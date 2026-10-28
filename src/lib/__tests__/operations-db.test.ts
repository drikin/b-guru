/**
 * 段階 3「操作」を本物の PostgreSQL で確かめる（docs/timeline-spec.md「アプリが使う API の約束」）。
 *
 * TIMELINE_TEST_DATABASE_URL があるときだけ動く。使い捨ての DB を指すこと（表を作り・列を落とし・行を消す）。
 * 将棋・ミニゲームの DB テストと同じ DB だと initSchema が同時に走ってぶつかるので、別の database にする。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       docker exec <名前> createdb -U postgres timeline
 *       TIMELINE_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/timeline npx vitest run operations-db
 *
 *  - agent_tokens.app_issued: アプリのログインで発行した鍵に付く・設定画面の鍵には付かない・既存の鍵には
 *    voice スコープを目印に initSchema が起動のたびに付ける（冪等・voice の無い鍵には付かない）
 *  - initSchema: 空の DB でも通る・2 回流しても表・列・索引が変わらない（本番の DB に変化を出さない）
 *  - 外部の鍵（post スコープでも）では人として書いた自分の投稿を消せない・直せない。アプリの鍵ならできる
 *  - 編集の制約（Web と同じ）・ピン（1 人 1 件）・部活・投票・お題の編集・お気に入り・ブックマーク・うなる
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";

const URL_ = process.env.TIMELINE_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

// 外へ出る呼び出し（Ghost・Web Push・AI の自動分類）は止める。
vi.mock("../ghost", () => ({ findMemberByEmail: async () => null, isPaidMember: () => true, listMembers: async () => [] }));
vi.mock("../push", () => ({ sendWebPush: async () => {} }));
vi.mock("../push-notify", () => ({ pushNewPost: async () => {}, pushPersonalNotification: async () => {}, syncRead: async () => 0 }));
vi.mock("../clubs", () => ({ classifyPost: async () => null }));
// Web のセッション（/api/publish・/api/poll/* を本物の DB で通す）。
const web = vi.hoisted(() => ({ email: null as string | null }));
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => web.email }));

const ME = `ops-me-${Date.now()}@test.local`;
const OTHER = `ops-other-${Date.now()}@test.local`;

type M = {
  db: typeof import("../db");
  auth: typeof import("../agent-auth");
  posts: typeof import("../posts");
  user: typeof import("../user");
};
let m: M;
const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);
const req = (url: string, token: string, init: RequestInit = {}) =>
  new NextRequest(
    new Request(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    })
  );
const P = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

let appToken = "";
let extPostToken = "";
let writeToken = "";

async function newPost(author: string, text: string, extra: Record<string, unknown> = {}) {
  const p = await m.posts.createPost({ authorEmail: author, authorName: author.split("@")[0], text, noPreview: true, ...extra });
  return p.id;
}
async function exists(id: number) {
  return (await sql(`SELECT 1 FROM posts WHERE id = $1`, [id])).rows.length === 1;
}

d("段階 3 の操作（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      auth: await import("../agent-auth"),
      posts: await import("../posts"),
      user: await import("../user"),
    };
    // 空の DB でも initSchema だけで表がそろうこと（drinews の作成順・reactions・custom_emojis・pinned_at）も
    // この beforeAll で確かめている（CI は毎回まっさらな DB）。
    // 「app_issued の列ができる前」の状態を作る（2 回目以降の実行でも同じ状態から始める）。
    await sql(`CREATE TABLE IF NOT EXISTS agent_tokens (
      id SERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, email TEXT NOT NULL, scopes TEXT[] NOT NULL DEFAULT '{read}',
      device_name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ, last_membership_check TIMESTAMPTZ, revoked_at TIMESTAMPTZ, last_ip INET)`);
    await sql(`ALTER TABLE agent_tokens DROP COLUMN IF EXISTS app_issued`);
    await sql(`CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await sql(`DELETE FROM schema_flags WHERE name = 'agent-tokens-app-issued-backfill'`);
    // 既存の鍵: アプリ（voice あり）と設定画面（voice なし）
    await sql(
      `INSERT INTO agent_tokens (token_hash, email, scopes, device_name, expires_at)
       VALUES ('old-app-${Date.now()}', $1, '{read,read_state,chat,post,voice}', 'iPhone', now() + interval '30 days'),
              ('old-ext-${Date.now()}', $1, '{read,post,write}', 'claude', now() + interval '30 days')`,
      [ME]
    );
    await m.db.initSchema();
    await m.user.ensureUserId(ME);
    await m.user.ensureUserId(OTHER);
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'わたし'), ($2, 'ほか') ON CONFLICT DO NOTHING`, [ME, OTHER]);
    await sql(`DELETE FROM agent_tokens WHERE email = $1 AND token_hash NOT LIKE 'old-%'`, [ME]);
    appToken = (await m.auth.issueAgentToken({ email: ME, deviceName: "iPhone", scopes: ["read", "read_state", "chat", "post", "voice"], appIssued: true })).token;
    extPostToken = (await m.auth.issueAgentToken({ email: ME, deviceName: "外部 post", scopes: ["read", "post"] })).token;
    writeToken = (await m.auth.issueAgentToken({ email: ME, deviceName: "外部 write", scopes: ["read", "write"] })).token;
  });

  describe("app_issued（アプリが発行した印）", () => {
    it("既存の鍵: voice を持つものだけに initSchema が印を付ける", async () => {
      const r = await sql(`SELECT device_name, app_issued FROM agent_tokens WHERE email = $1 AND token_hash LIKE 'old-%' ORDER BY id`, [ME]);
      expect(r.rows.map((x) => [x.device_name, x.app_issued])).toEqual([["iPhone", true], ["claude", false]]);
    });

    it("印付けは起動のたびに（冪等）: voice の鍵には付き、voice の無い鍵には付かない", async () => {
      await sql(
        `INSERT INTO agent_tokens (token_hash, email, scopes, device_name, expires_at, app_issued)
         VALUES ('later-a-${Date.now()}', $1, '{read,voice}', 'あとから voice', now() + interval '1 day', false),
                ('later-b-${Date.now()}', $1, '{read,post}', 'あとから外部', now() + interval '1 day', false)`,
        [ME]
      );
      await m.db.initSchema();
      await m.db.initSchema();
      const r = await sql(`SELECT device_name, app_issued FROM agent_tokens WHERE email = $1 AND device_name LIKE 'あとから%' ORDER BY id`, [ME]);
      expect(r.rows.map((x) => [x.device_name, x.app_issued])).toEqual([["あとから voice", true], ["あとから外部", false]]);
      await sql(`DELETE FROM agent_tokens WHERE device_name LIKE 'あとから%'`);
    });

    it("initSchema を 2 回流しても表・列・制約・索引は変わらない（本番の DB に変化を出さない）", async () => {
      const snap = async () =>
        JSON.stringify([
          (await sql(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                       WHERE table_schema = 'public' ORDER BY table_name, column_name`)).rows,
          (await sql(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
                       WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)).rows,
          (await sql(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`)).rows,
        ]);
      const before = await snap();
      await m.db.initSchema();
      expect(await snap()).toBe(before);
      for (const t of ["reactions", "custom_emojis", "drinews_articles", "drinews_comments"]) {
        expect((await sql(`SELECT to_regclass($1) AS r`, [t])).rows[0].r, t).toBe(t);
      }
      expect((await sql(`SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'pinned_at'`)).rows).toHaveLength(1);
    });

    it("新しく発行する鍵: アプリのログインは true・設定画面は false", async () => {
      const r = await sql(`SELECT device_name, app_issued FROM agent_tokens WHERE email = $1 AND token_hash NOT LIKE 'old-%' ORDER BY id`, [ME]);
      expect(r.rows.map((x) => [x.device_name, x.app_issued])).toEqual([
        ["iPhone", true],
        ["外部 post", false],
        ["外部 write", false],
      ]);
    });

    it("capabilities: アプリの鍵だけ edit・外部の post だけの鍵は edit も delete も無い・write は本文だけ", async () => {
      const { GET } = await import("@/app/api/agent/capabilities/route");
      const caps = async (t: string) => (await (await GET(req("http://x/api/agent/capabilities", t))).json()).features.posts;
      expect(await caps(appToken)).toMatchObject({ edit: true, delete: true, edit_text_only: false, pin: true, poll: true, video: true, favorites: true, club_change: true, bookmarks_set: true, club_visibility: "/api/agent/clubs/visibility" });
      // 外部の鍵は今までできたことだけ（新しい操作は false）
      expect(await caps(extPostToken)).toMatchObject({
        edit: false, delete: false, edit_text_only: false, whisper: true, bookmarks: true,
        video: false, audio: false, poll: false, poll_vote: false, poll_edit: false, pin: false, favorites: false, club_select: false, club_change: false, club_visibility: null,
      });
      expect(await caps(writeToken)).toMatchObject({ edit: false, delete: true, edit_text_only: true, pin: false, poll_vote: false, favorites: false });
    });
  });

  describe("編集・削除の権限", () => {
    it("★ 外部の鍵（post スコープ）では人として書いた自分の投稿を消せない・直せない", async () => {
      const { DELETE, PATCH } = await import("@/app/api/agent/posts/[id]/route");
      const id = await newPost(ME, "人として書いた投稿");
      const del = await DELETE(req(`http://x/api/agent/posts/${id}`, extPostToken, { method: "DELETE" }), P(id));
      expect(del.status).toBe(403);
      const patch = await PATCH(req(`http://x/api/agent/posts/${id}`, extPostToken, { method: "PATCH", body: JSON.stringify({ text: "x" }) }), P(id));
      expect(patch.status).toBe(403);
      expect(await exists(id)).toBe(true);
      expect((await sql(`SELECT text FROM posts WHERE id = $1`, [id])).rows[0].text).toBe("人として書いた投稿");
    });

    it("アプリの鍵なら Web と同じに直せる（本文・画像の差し替え・音声）・消せる", async () => {
      const { DELETE, PATCH } = await import("@/app/api/agent/posts/[id]/route");
      const id = await newPost(ME, "直す前", { images: ["/api/media/a.jpg"] });
      const patch = await PATCH(
        req(`http://x/api/agent/posts/${id}`, appToken, {
          method: "PATCH",
          body: JSON.stringify({ text: "直した", images: ["/api/media/b.jpg", "/api/media/c.jpg"], audio_url: "/api/media/v.m4a" }),
        }),
        P(id)
      );
      expect(patch.status).toBe(200);
      expect(await patch.json()).toEqual({ apiVersion: 1, updated: true });
      const row = (await sql(`SELECT text, audio_url FROM posts WHERE id = $1`, [id])).rows[0];
      expect(row).toEqual({ text: "直した", audio_url: "/api/media/v.m4a" });
      const imgs = (await sql(`SELECT url FROM post_images WHERE post_id = $1 ORDER BY sort_order`, [id])).rows.map((r) => r.url);
      expect(imgs).toEqual(["/api/media/b.jpg", "/api/media/c.jpg"]);
      const del = await DELETE(req(`http://x/api/agent/posts/${id}`, appToken, { method: "DELETE" }), P(id));
      expect(del.status).toBe(200);
      expect(await exists(id)).toBe(false);
    });

    it("アプリの鍵でも他人の投稿・エピソード投稿は不可、動画付きに音声は付けられない、外部の画像 URL は不可", async () => {
      const { DELETE, PATCH } = await import("@/app/api/agent/posts/[id]/route");
      const others = await newPost(OTHER, "ほかの人");
      expect((await DELETE(req(`http://x/api/agent/posts/${others}`, appToken, { method: "DELETE" }), P(others))).status).toBe(403);
      expect(await exists(others)).toBe(true);
      const ep = await newPost(ME, "エピソード");
      await sql(`UPDATE posts SET source_ghost_id = 'ep-${ep}' WHERE id = $1`, [ep]);
      const epDel = await DELETE(req(`http://x/api/agent/posts/${ep}`, appToken, { method: "DELETE" }), P(ep));
      expect(epDel.status).toBe(403);
      expect((await epDel.json()).error).toBe("エピソード投稿は削除できません");
      const vid = await newPost(ME, "動画", { videoUrl: "/api/media/v.mp4" });
      const both = await PATCH(req(`http://x/api/agent/posts/${vid}`, appToken, { method: "PATCH", body: JSON.stringify({ text: "x", audio_url: "/api/media/a.m4a" }) }), P(vid));
      expect(both.status).toBe(400);
      expect((await both.json()).error).toBe("動画と音声は同時に添付できません");
      const ext = await PATCH(req(`http://x/api/agent/posts/${vid}`, appToken, { method: "PATCH", body: JSON.stringify({ text: "x", images: ["https://evil.example/a.jpg"] }) }), P(vid));
      expect(ext.status).toBe(400);
      expect((await DELETE(req(`http://x/api/agent/posts/999999999`, appToken, { method: "DELETE" }), P(999999999))).status).toBe(404);
    });

    it("write スコープの今の振る舞いは変えない（本文だけ直せる・消せる）", async () => {
      const { DELETE, PATCH } = await import("@/app/api/agent/posts/[id]/route");
      const id = await newPost(ME, "エージェント前", { images: ["/api/media/keep.jpg"] });
      const patch = await PATCH(req(`http://x/api/agent/posts/${id}`, writeToken, { method: "PATCH", body: JSON.stringify({ text: "エージェント後", images: [] }) }), P(id));
      expect(patch.status).toBe(200);
      const imgs = (await sql(`SELECT url FROM post_images WHERE post_id = $1`, [id])).rows.map((r) => r.url);
      expect(imgs).toEqual(["/api/media/keep.jpg"]); // write は画像を触らない
      expect((await DELETE(req(`http://x/api/agent/posts/${id}`, writeToken, { method: "DELETE" }), P(id))).status).toBe(200);
    });
  });

  describe("そのほかの操作（Web と同じ lib）", () => {
    it("ピン: 自分の投稿だけ・1 人 1 件・付け外し、一覧は posts?pinned=1", async () => {
      const { POST } = await import("@/app/api/agent/posts/[id]/pin/route");
      const { GET } = await import("@/app/api/agent/posts/route");
      const a = await newPost(ME, "ピン A");
      const b = await newPost(ME, "ピン B");
      const o = await newPost(OTHER, "他人");
      expect(await (await POST(req("http://x", appToken, { method: "POST" }), P(a))).json()).toMatchObject({ ok: true, pinned: true });
      expect(await (await POST(req("http://x", appToken, { method: "POST" }), P(b))).json()).toMatchObject({ pinned: true });
      expect((await POST(req("http://x", appToken, { method: "POST" }), P(o))).status).toBe(403);
      const list = await (await GET(req("http://x/api/agent/posts?pinned=1", appToken))).json();
      const mine = list.posts.filter((p: { id: number }) => p.id === a || p.id === b).map((p: { id: number }) => p.id);
      expect(mine).toEqual([b]); // 新しくピンしたほうだけ残る
      expect(list.next_cursor).toBeNull();
      expect(await (await POST(req("http://x", appToken, { method: "POST" }), P(b))).json()).toMatchObject({ pinned: false });
      expect((await POST(req("http://x", writeToken, { method: "POST" }), P(a))).status).toBe(403); // post スコープが要る
    });

    it("部活: 付け替えは投稿者だけ・club_manual になる・不正なキーは 400", async () => {
      const { PATCH } = await import("@/app/api/agent/posts/[id]/club/route");
      await sql(`INSERT INTO clubs (key, name, category, definition, active, manual, sort) VALUES ('opsclub', '検査部', 'その他', '', TRUE, TRUE, 999) ON CONFLICT (key) DO NOTHING`);
      const id = await newPost(ME, "部活");
      const ok = await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ club: "opsclub" }) }), P(id));
      expect(await ok.json()).toEqual({ apiVersion: 1, ok: true, club: "opsclub" });
      expect((await sql(`SELECT club, club_manual FROM posts WHERE id = $1`, [id])).rows[0]).toEqual({ club: "opsclub", club_manual: true });
      expect((await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ club: "nope" }) }), P(id))).status).toBe(400);
      const o = await newPost(OTHER, "他人");
      expect((await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ club: "opsclub" }) }), P(o))).status).toBe(403);
    });

    it("投稿: 部活の手動選択・うなる（返信だけ）・投票の作成・動画と音声は同時に付けられない", async () => {
      const { POST } = await import("@/app/api/agent/publish/route");
      const pub = (body: unknown) => POST(req("http://x/api/agent/publish", appToken, { method: "POST", body: JSON.stringify(body) }));
      const withClub = await pub({ text: `部活つき ${Date.now()}`, club: "opsclub" });
      expect(withClub.status).toBe(201);
      const post = (await withClub.json()).post;
      expect(post).toMatchObject({ club: "opsclub", club_manual: true });
      expect((await pub({ text: "x", club: "nope" })).status).toBe(400);
      expect((await pub({ text: "返信に部活", parent_id: post.id, club: "opsclub" })).status).toBe(400);
      expect((await pub({ text: "ルートでうなる", whisper: true })).status).toBe(400);
      const w = await pub({ text: `うなる ${Date.now()}`, parent_id: post.id, whisper: true });
      expect(w.status).toBe(201);
      expect((await sql(`SELECT is_whisper FROM posts WHERE id = $1`, [(await w.json()).post.id])).rows[0].is_whisper).toBe(true);
      expect((await pub({ text: "両方", video_url: "/api/media/v.mp4", audio_url: "/api/media/a.m4a" })).status).toBe(400);
      const poll = await pub({ text: "どれ？", poll: { question: "どれ？", options: ["A", "B", "C"], duration_hours: 1 } });
      expect(poll.status).toBe(201);
      expect((await poll.json()).post.poll.options.map((o: { label: string }) => o.label)).toEqual(["A", "B", "C"]);
      expect((await pub({ text: "少ない", poll: { question: "少ない", options: ["A"], duration_hours: 1 } })).status).toBe(400);
    });

    it("投票: 1 人 1 票で変えられる・締切後は 403・お題の編集は投稿者だけで票の付いた選択肢は消せない", async () => {
      const { POST: vote } = await import("@/app/api/agent/posts/[id]/poll/vote/route");
      const { PUT: edit } = await import("@/app/api/agent/posts/[id]/poll/route");
      const p = await m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "お題", noPreview: true, poll: { question: "お題", options: ["A", "B", "C"], durationHours: 1 } });
      const [o1, o2, o3] = p.poll!.options.map((o) => o.id);
      const v = (opt: number, t = appToken) => vote(req("http://x", t, { method: "POST", body: JSON.stringify({ option_id: opt }) }), P(p.id));
      expect((await (await v(o1)).json()).poll.myVote).toBe(o1);
      expect((await (await v(o2)).json()).poll.myVote).toBe(o2);
      expect((await v(999999)).status).toBe(400);
      const e = (body: unknown, t = appToken) => edit(req("http://x", t, { method: "PUT", body: JSON.stringify(body) }), P(p.id));
      // 票の付いた o2 を消そうとすると 400、0 票の o3 を消して D を足すのは通る
      expect((await e({ options: [{ id: o1, label: "A" }, { id: o3, label: "C" }, { id: null, label: "D" }] })).status).toBe(400);
      const ok = await e({ options: [{ id: o1, label: "A2" }, { id: o2, label: "B" }, { id: null, label: "D" }] });
      expect(ok.status).toBe(200);
      expect((await ok.json()).poll.options.map((o: { label: string }) => o.label)).toEqual(["A2", "B", "D"]);
      // 他人はお題を編集できない
      const otherTok = (await m.auth.issueAgentToken({ email: OTHER, deviceName: "Android", scopes: ["read", "post"], appIssued: true })).token;
      expect((await e({ options: [{ id: o1, label: "x" }, { id: o2, label: "y" }, { id: null, label: "z" }] }, otherTok)).status).toBe(403);
      // 締切後
      await sql(`UPDATE post_polls SET ends_at = now() - interval '1 minute' WHERE post_id = $1`, [p.id]);
      const late = await v(o1);
      expect(late.status).toBe(403);
      expect((await late.json()).error).toBe("投票は終了しました");
    });

    it("投票した人: 投稿者だけ（Web・アプリの鍵）が選択肢ごとに見られる・他人と外部の鍵は 403・メールは返さない", async () => {
      const { POST: vote } = await import("@/app/api/agent/posts/[id]/poll/vote/route");
      const { GET: voters } = await import("@/app/api/agent/posts/[id]/poll/voters/route");
      const webPoll = await import("@/app/api/poll/[postId]/route");
      const p = await m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "誰が", noPreview: true, poll: { question: "誰が", options: ["A", "B", "C"], durationHours: 1 } });
      const [o1, o2, o3] = p.poll!.options.map((o) => o.id);
      const otherTok = (await m.auth.issueAgentToken({ email: OTHER, deviceName: "Android", scopes: ["read", "post"], appIssued: true })).token;
      const v = (opt: number, t: string) => vote(req("http://x", t, { method: "POST", body: JSON.stringify({ option_id: opt }) }), P(p.id));
      expect((await v(o1, otherTok)).status).toBe(200);
      expect((await v(o2, appToken)).status).toBe(200);
      const get = (t: string) => voters(req("http://x", t), P(p.id));

      const ok = await get(appToken);
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(text).not.toContain("@test.local");
      const body = JSON.parse(text) as { options: { id: number; voters: { user_id: string; avatar: string }[] }[] };
      expect(body.options.map((o) => [o.id, o.voters.length])).toEqual([[o1, 1], [o2, 1], [o3, 0]]);
      expect(body.options[0].voters[0].user_id).toBe(await m.user.ensureUserId(OTHER));
      expect(body.options[0].voters[0].avatar).toMatch(/^\/api\/avatar\//);

      for (const [name, t] of [["他人", otherTok], ["外部の鍵", extPostToken]] as const) {
        const r = await get(t);
        expect(r.status, name).toBe(403);
        expect((await r.json()).code, name).toBe("forbidden");
      }
      expect((await voters(req("http://x", appToken), P(99999999))).status).toBe(404);

      const wp = { params: Promise.resolve({ postId: String(p.id) }) };
      web.email = OTHER;
      expect((await webPoll.GET(new NextRequest("http://x"), wp)).status).toBe(403);
      web.email = ME;
      const w = await webPoll.GET(new NextRequest("http://x"), wp);
      expect(w.status).toBe(200);
      expect((await w.json()).options[1].voters).toHaveLength(1);
      web.email = null;
      expect((await webPoll.GET(new NextRequest("http://x"), wp)).status).toBe(401);
    });

    it("お気に入りとブックマーク: アプリの鍵（write なし）で付け外しでき、投稿に状態が載る", async () => {
      const fav = await import("@/app/api/agent/favorites/route");
      const bm = await import("@/app/api/agent/bookmarks/route");
      const { GET: thread } = await import("@/app/api/agent/posts/[id]/route");
      const otherId = await m.user.ensureUserId(OTHER);
      const id = await newPost(OTHER, "お気に入りの人の投稿");
      const add = await fav.POST(req("http://x", appToken, { method: "POST", body: JSON.stringify({ user_id: otherId }) }));
      expect(await add.json()).toEqual({ apiVersion: 1, favorited: true });
      expect((await (await fav.GET(req("http://x", appToken))).json()).user_ids).toContain(otherId);
      const myId = await m.user.ensureUserId(ME);
      expect((await fav.POST(req("http://x", appToken, { method: "POST", body: JSON.stringify({ user_id: myId }) }))).status).toBe(400);
      expect((await (await bm.POST(req("http://x", appToken, { method: "POST", body: JSON.stringify({ post_id: id }) }))).json()).bookmarked).toBe(true);
      const t = await (await thread(req(`http://x/api/agent/posts/${id}`, appToken), P(id))).json();
      expect(t.post).toMatchObject({ bookmarked_by_me: true, favorite_by_me: true });
      expect(await (await fav.DELETE(req("http://x", appToken, { method: "DELETE", body: JSON.stringify({ user_id: otherId }) }))).json()).toEqual({ apiVersion: 1, favorited: false });
    });

    it("カスタム絵文字の一覧は登録した人（メール）を出さない", async () => {
      await sql(`INSERT INTO custom_emojis (name, image_url, created_by) VALUES ('opsemoji', '/api/media/e.png', $1) ON CONFLICT (name) DO NOTHING`, [ME]);
      const { GET } = await import("@/app/api/agent/emojis/route");
      const text = await (await GET(req("http://x", appToken))).text();
      expect(JSON.parse(text).emojis).toContainEqual(expect.objectContaining({ name: "opsemoji", image_url: "/api/media/e.png" }));
      expect(text).not.toContain("@test.local");
    });
  });

  describe("レビュー 1 回目の指摘", () => {
    it("★ 外部の鍵（post）は人の投稿への新しい操作ができない（403）。リアクション・ブックマーク・うなるは今までどおり", async () => {
      const { POST: pin } = await import("@/app/api/agent/posts/[id]/pin/route");
      const { PATCH: club } = await import("@/app/api/agent/posts/[id]/club/route");
      const { POST: vote } = await import("@/app/api/agent/posts/[id]/poll/vote/route");
      const { PUT: pollEdit } = await import("@/app/api/agent/posts/[id]/poll/route");
      const fav = await import("@/app/api/agent/favorites/route");
      const { POST: publish } = await import("@/app/api/agent/publish/route");
      const { POST: bm } = await import("@/app/api/agent/bookmarks/route");
      const { POST: react } = await import("@/app/api/agent/reactions/route");
      const p = await m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "外部の線引き", noPreview: true, poll: { question: "q", options: ["A", "B", "C"], durationHours: 1 } });
      const opt = p.poll!.options[0].id;
      const otherId = await m.user.ensureUserId(OTHER);
      const t = extPostToken;
      const cases: [string, () => Promise<Response>][] = [
        ["pin", () => pin(req("http://x", t, { method: "POST" }), P(p.id))],
        ["club", () => club(req("http://x", t, { method: "PATCH", body: JSON.stringify({ club: null }) }), P(p.id))],
        ["vote", () => vote(req("http://x", t, { method: "POST", body: JSON.stringify({ option_id: opt }) }), P(p.id))],
        ["poll edit", () => pollEdit(req("http://x", t, { method: "PUT", body: JSON.stringify({ options: [{ id: opt, label: "x" }] }) }), P(p.id))],
        ["favorites add", () => fav.POST(req("http://x", t, { method: "POST", body: JSON.stringify({ user_id: otherId }) }))],
        ["favorites remove", () => fav.DELETE(req("http://x", t, { method: "DELETE", body: JSON.stringify({ user_id: otherId }) }))],
        ["publish poll", () => publish(req("http://x", t, { method: "POST", body: JSON.stringify({ text: "q", poll: { question: "q", options: ["A", "B", "C"] } }) }))],
        ["publish video", () => publish(req("http://x", t, { method: "POST", body: JSON.stringify({ text: "v", video_url: "/api/media/v.mp4" }) }))],
        ["publish audio", () => publish(req("http://x", t, { method: "POST", body: JSON.stringify({ text: "a", audio_url: "/api/media/a.m4a" }) }))],
        ["publish club", () => publish(req("http://x", t, { method: "POST", body: JSON.stringify({ text: "c", club: "opsclub" }) }))],
      ];
      for (const [name, call] of cases) {
        const res = await call();
        expect(res.status, name).toBe(403);
        expect((await res.json()).code, name).toBe("forbidden");
      }
      // write の鍵も新しい操作は不可（今までできたことだけ）
      expect((await fav.POST(req("http://x", writeToken, { method: "POST", body: JSON.stringify({ user_id: otherId }) }))).status).toBe(403);
      // 今までどおりできること
      expect((await bm(req("http://x", t, { method: "POST", body: JSON.stringify({ post_id: p.id }) }))).status).toBe(200);
      expect((await react(req("http://x", t, { method: "POST", body: JSON.stringify({ post_id: p.id, emoji: "👍" }) }))).status).toBe(200);
      const w = await publish(req("http://x", t, { method: "POST", body: JSON.stringify({ text: `外部のうなる ${Date.now()}`, parent_id: p.id, whisper: true }) }));
      expect(w.status).toBe(201);
    });

    it("お題の編集: 他の投票の選択肢 id・重複 id・空の回答・実際に残る数が 3 未満は 400", async () => {
      const { PUT: edit } = await import("@/app/api/agent/posts/[id]/poll/route");
      const mk = () => m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "検査", noPreview: true, poll: { question: "検査", options: ["A", "B", "C"], durationHours: 1 } });
      const a = await mk();
      const b = await mk();
      const [a1, a2, a3] = a.poll!.options.map((o) => o.id);
      const b1 = b.poll!.options[0].id;
      const e = async (options: unknown) => {
        const res = await edit(req("http://x", appToken, { method: "PUT", body: JSON.stringify({ options }) }), P(a.id));
        return { status: res.status, error: (await res.json()).error };
      };
      expect(await e([{ id: a1, label: "A" }, { id: a2, label: "B" }, { id: b1, label: "他の投票" }])).toEqual({ status: 400, error: "選択肢が不正です" });
      expect(await e([{ id: a1, label: "A" }, { id: a1, label: "A2" }, { id: a2, label: "B" }])).toEqual({ status: 400, error: "選択肢が重複しています" });
      expect(await e([{ id: a1, label: "A" }, { id: a2, label: "B" }, { id: null, label: "  " }])).toEqual({ status: 400, error: "回答を入力してください" });
      expect((await e([{ id: a1, label: "A" }, { id: a2, label: "B" }])).status).toBe(400);
      expect((await e(Array.from({ length: 11 }, (_, i) => ({ id: null, label: `x${i}` })))).status).toBe(400);
      // 他の投票の選択肢は変わっていない
      expect((await sql(`SELECT label FROM post_poll_options WHERE id = $1`, [b1])).rows[0].label).toBe("A");
      expect((await e([{ id: a1, label: "A" }, { id: a2, label: "B" }, { id: a3, label: "C2" }])).status).toBe(200);
    });

    it("お題の編集: 並べ替え・途中への追加ができる（sort_order の UNIQUE で 500 にならない）", async () => {
      const { PUT: edit } = await import("@/app/api/agent/posts/[id]/poll/route");
      const p = await m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "並べ替え", noPreview: true, poll: { question: "並べ替え", options: ["A", "B", "C"], durationHours: 1 } });
      const [a, b, c] = p.poll!.options.map((o) => o.id);
      const put = async (options: unknown) => {
        const res = await edit(req("http://x", appToken, { method: "PUT", body: JSON.stringify({ options }) }), P(p.id));
        return { status: res.status, labels: ((await res.json()).poll?.options ?? []).map((o: { label: string }) => o.label) };
      };
      expect(await put([{ id: c, label: "C" }, { id: a, label: "A" }, { id: b, label: "B" }])).toEqual({ status: 200, labels: ["C", "A", "B"] });
      expect(await put([{ id: c, label: "C" }, { id: null, label: "新" }, { id: a, label: "A" }, { id: b, label: "B" }])).toEqual({ status: 200, labels: ["C", "新", "A", "B"] });
      const rows = (await sql(`SELECT sort_order FROM post_poll_options WHERE post_id = $1 ORDER BY sort_order`, [p.id])).rows.map((r) => r.sort_order);
      expect(rows).toEqual([0, 1, 2, 3]);
    });

    it("編集の画像: その投稿にもう付いている画像（Web から付けた外部 URL など）は残せる・新しい外部 URL は不可", async () => {
      const { PATCH } = await import("@/app/api/agent/posts/[id]/route");
      const id = await newPost(ME, "Web から", { images: ["https://cdn.example/old.jpg"] });
      const keep = await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ text: "本文だけ直す", images: ["https://cdn.example/old.jpg"] }) }), P(id));
      expect(keep.status).toBe(200);
      const add = await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ text: "x", images: ["https://cdn.example/old.jpg", "https://evil.example/new.jpg"] }) }), P(id));
      expect(add.status).toBe(400);
      const mix = await PATCH(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ text: "y", images: ["https://cdn.example/old.jpg", "/api/media/new.jpg"] }) }), P(id));
      expect(mix.status).toBe(200);
    });

    it("ピン・部活の付け替えは返信には使えない（400）", async () => {
      const { POST: pin } = await import("@/app/api/agent/posts/[id]/pin/route");
      const { PATCH: club } = await import("@/app/api/agent/posts/[id]/club/route");
      const root = await newPost(ME, "ルート");
      const reply = await newPost(ME, "返信", { parentId: root });
      const p = await pin(req("http://x", appToken, { method: "POST" }), P(reply));
      expect(p.status).toBe(400);
      expect((await p.json()).error).toBe("返信はピンできません");
      expect((await club(req("http://x", appToken, { method: "PATCH", body: JSON.stringify({ club: null }) }), P(reply))).status).toBe(400);
    });

    it("ブックマークは bookmarked: true|false で冪等（無ければ切り替え）", async () => {
      const { POST } = await import("@/app/api/agent/bookmarks/route");
      const id = await newPost(OTHER, "ブックマーク");
      const set = async (body: unknown) => (await (await POST(req("http://x", appToken, { method: "POST", body: JSON.stringify(body) }))).json()).bookmarked;
      expect(await set({ post_id: id, bookmarked: true })).toBe(true);
      expect(await set({ post_id: id, bookmarked: true })).toBe(true);
      expect(await set({ post_id: id, bookmarked: false })).toBe(false);
      expect(await set({ post_id: id, bookmarked: false })).toBe(false);
      expect(await set({ post_id: id })).toBe(true); // 切り替え
      expect((await POST(req("http://x", appToken, { method: "POST", body: JSON.stringify({ post_id: id, bookmarked: "yes" }) }))).status).toBe(400);
    });
  });

  describe("Web の投稿画面（アプリに合わせた部活の選択・回答の編集）", () => {
    it("/api/publish に club を付けると club_manual で付き、自動分類しない。返信には付けられない", async () => {
      const { POST } = await import("@/app/api/publish/route");
      web.email = ME;
      const pub = (body: unknown) => POST(new NextRequest(new Request("http://x/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
      const r = await pub({ text: `Web から部活つき ${Date.now()}`, club: "opsclub" });
      expect(r.status).toBe(201);
      const post = (await r.json()).post;
      expect(post).toMatchObject({ club: "opsclub", clubManual: true });
      expect((await sql(`SELECT club, club_manual FROM posts WHERE id = $1`, [post.id])).rows[0]).toEqual({ club: "opsclub", club_manual: true });
      expect((await pub({ text: "返信に部活", parentId: post.id, club: "opsclub" })).status).toBe(400);
      expect((await pub({ text: "x", club: "nope" })).status).toBe(400);
      web.email = null;
    });

    it("★ 投票の作成で文字列でない回答は 400（上限をすり抜けて保存できない）・Web とアプリの publish の両方", async () => {
      const { POST: webPublish } = await import("@/app/api/publish/route");
      const { POST: appPublish } = await import("@/app/api/agent/publish/route");
      web.email = ME;
      const long = "x".repeat(5000);
      const bad = [
        ["A", "B", { toString: () => long }],
        ["A", "B", ["C", long]],
        ["A", "B", 3],
        Array.from({ length: 30 }, (_, i) => (i < 3 ? `ok${i}` : [i])),
      ];
      for (const options of bad) {
        const w = await webPublish(new NextRequest(new Request("http://x/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `q ${Date.now()}`, poll: { question: "q", options, durationHours: 1 } }) })));
        expect(w.status).toBe(400);
        expect((await w.json()).error).toBe("回答は文字列で入力してください");
        const a = await appPublish(req("http://x/api/agent/publish", appToken, { method: "POST", body: JSON.stringify({ text: `q ${Date.now()}`, poll: { question: "q", options, duration_hours: 1 } }) }));
        expect(a.status).toBe(400);
      }
      expect((await sql(`SELECT count(*)::int AS n FROM post_poll_options WHERE length(label) > 100`)).rows[0].n).toBe(0);
      // 文字列の回答（前後の空白・空は落とす）は今までどおり通る
      const ok = await webPublish(new NextRequest(new Request("http://x/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `ok ${Date.now()}`, poll: { question: "q", options: [" A ", "B", "C", ""], durationHours: 1 } }) })));
      expect(ok.status).toBe(201);
      expect((await ok.json()).post.poll.options.map((o: { label: string }) => o.label)).toEqual(["A", "B", "C"]);
      web.email = null;
    });

    it("/api/poll/:id の回答の編集（Web が送る形: 空を除いて trim 済み）が通る・空を混ぜると 400", async () => {
      const { PUT } = await import("@/app/api/poll/[postId]/route");
      web.email = ME;
      const p = await m.posts.createPost({ authorEmail: ME, authorName: "わたし", text: "Web の回答編集", noPreview: true, poll: { question: "Web の回答編集", options: ["A", "B", "C"], durationHours: 1 } });
      const [a, b, c] = p.poll!.options.map((o) => o.id);
      const put = (options: unknown) =>
        PUT(new NextRequest(new Request(`http://x/api/poll/${p.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ options }) })), { params: Promise.resolve({ postId: String(p.id) }) });
      expect((await put([{ id: a, label: "A" }, { id: b, label: "B" }, { id: c, label: "C" }, { id: null, label: "" }])).status).toBe(400);
      const ok = await put([{ id: a, label: "A" }, { id: b, label: "B" }, { id: c, label: "C" }, { id: null, label: "D" }]);
      expect(ok.status).toBe(200);
      expect((await ok.json()).poll.options.map((o: { label: string }) => o.label)).toEqual(["A", "B", "C", "D"]);
      web.email = null;
    });
  });
});
