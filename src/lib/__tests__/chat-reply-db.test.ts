/**
 * ↩️ チャットの返信（lib/chat.ts の reply_to_id と replyTo、lib/agent-chat.ts の reply_to）を本物の DB で確かめる。
 *
 * 本物の PostgreSQL が要る。DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run chat-reply-db --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

vi.mock("../push-notify", () => ({
  pushChatMessage: async () => 0,
  syncRead: async () => 0,
}));

type Mods = {
  db: typeof import("../db");
  chat: typeof import("../chat");
  agent: typeof import("../agent-chat");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `reply-a-${stamp}@test.local`;
const B = `reply-b-${stamp}@test.local`;

d("↩️ チャットの返信（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      chat: await import("../chat"),
      agent: await import("../agent-chat"),
      user: await import("../user"),
    };
    await m.db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    await m.user.ensureUserId(A);
    await m.user.ensureUserId(B);
    await m.db.pool.query(
      `INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`,
      [A, B]
    );
  });

  it("返信は返信先（名前と冒頭）つきで返り、一覧・1 件・編集・エージェントの形でも同じ", async () => {
    const q = await m.chat.sendChatMessage(A, "今日のオフ会、何時からでしたっけ？   場所も知りたいです");
    const r = await m.chat.sendChatMessage(B, "@ねこ 19 時からです", null, [], q.id);
    expect(r.replyTo).toEqual({ id: q.id, authorName: "ねこ", excerpt: "今日のオフ会、何時からでしたっけ？ 場所も知りたいです" });

    const list = await m.chat.listChatMessages({ viewerEmail: A, limit: 200 });
    const inList = list.find((x) => x.id === r.id);
    expect(inList?.replyTo?.id).toBe(q.id);
    expect(list.find((x) => x.id === q.id)?.replyTo).toBeUndefined();

    expect((await m.chat.getChatMessage(r.id, A))?.replyTo?.authorName).toBe("ねこ");
    const edited = await m.chat.editChatMessage(r.id, B, "@ねこ 19 時半からでした");
    expect(edited?.replyTo?.id).toBe(q.id);

    const dto = m.agent.toAgentChatDto(inList!, { userId: null, mentionNames: new Set() });
    expect(dto.reply_to).toEqual({ id: q.id, author_name: "ねこ", excerpt: expect.stringContaining("何時から") });
  });

  it("長い本文は冒頭だけ、写真だけは 📷 写真", async () => {
    expect(m.chat.chatReplyExcerpt("あ".repeat(100), [])).toBe("あ".repeat(m.chat.CHAT_REPLY_EXCERPT) + "…");
    expect(m.chat.chatReplyExcerpt("", ["/api/media/chat-1.jpg"])).toBe("📷 写真");
  });

  it("ない・消えた返信先は保存しない／消えたら名前なしで返す", async () => {
    const none = await m.chat.sendChatMessage(A, "どこにも返信していない", null, [], 2_000_000_000);
    expect(none.replyTo).toBeUndefined();

    const q = await m.chat.sendChatMessage(B, "すぐ消える発言");
    const r = await m.chat.sendChatMessage(A, "それへの返信", null, [], q.id);
    await m.chat.deleteChatMessage(q.id);
    const after = await m.chat.getChatMessage(r.id, A);
    expect(after?.replyTo).toEqual({ id: q.id, authorName: null, excerpt: "" });
  });

  it("B-guru の知らせ行には返信できない", async () => {
    const note = await m.chat.postChatNotice(`テストの知らせ ${stamp}`);
    const r = await m.chat.sendChatMessage(A, "知らせへの返信", null, [], note!.id);
    expect(r.replyTo).toBeUndefined();
  });
});
