/**
 * チャットのネイティブアプリ対応（pure 部分）:
 *  - 楽観送信の照合（reconcileChat）
 *  - agent DTO（is_author / mentions_me / client_id の扱い）
 *  - 放送イベント → 個人ストリームの変換
 *  - capabilities がトークンのスコープを反映すること
 *  - 送信本文・client_id の検証（Web とエージェントで共通）
 */
import { describe, it, expect } from "vitest";
import { reconcileChat, markChatFailed, markChatRetrying, newChatClientId, newChatTempId, type ChatRow } from "../chat-optimistic";
import { toAgentChatDto, liveToStreamEvent, agentCapabilities } from "../agent-chat";
import { isMentionedIn, mentionNamesFor, mentionToken } from "../chat-mention";
import { normalizeChatBody, normalizeClientId, CHAT_MAX_BODY } from "../chat";

const base = {
  authorId: "uid_a",
  isAuthor: false,
  authorName: "A",
  body: "hi",
  createdAt: "2026-10-15T00:00:00Z",
  avatar: null,
  edited: false,
  editedAt: null,
};

describe("reconcileChat（楽観送信）", () => {
  const pending = (cid: string, id = -1): ChatRow => ({ ...base, id, isAuthor: true, clientId: cid, pending: true });

  it("同じ clientId の pending 行をその場で置き換える（順序を保つ）", () => {
    const prev: ChatRow[] = [{ ...base, id: 10 }, pending("c1"), { ...base, id: 11 }];
    const next = reconcileChat(prev, { ...base, id: 12, isAuthor: true, clientId: "c1" });
    expect(next.map((m) => m.id)).toEqual([10, 12, 11]);
    expect(next[1].pending).toBeUndefined();
  });

  it("SSE と POST 応答の両方が来ても重複しない", () => {
    const prev: ChatRow[] = [pending("c1")];
    const real = { ...base, id: 12, isAuthor: true, clientId: "c1" };
    const once = reconcileChat(prev, real);
    const twice = reconcileChat(once, real);
    expect(twice).toHaveLength(1);
    expect(twice[0].id).toBe(12);
  });

  it("確定済みの id が先に入っていたら pending の残りを消す", () => {
    const prev: ChatRow[] = [{ ...base, id: 12, isAuthor: true }, pending("c1")];
    expect(reconcileChat(prev, { ...base, id: 12, clientId: "c1" }).map((m) => m.id)).toEqual([12]);
  });

  it("他人が同じ clientId を名乗っても自分の pending は置き換わらない", () => {
    const next = reconcileChat([pending("c1")], { ...base, id: 14, authorId: "uid_evil", clientId: "c1" });
    expect(next.map((m) => m.id)).toEqual([-1, 14]);
    expect(next[0].pending).toBe(true);
  });

  it("2 回目に同じ内容が届いても配列を作り直さない（再レンダーを増やさない）", () => {
    const prev: ChatRow[] = [{ ...base, id: 12, isAuthor: true, clientId: "c1" }];
    expect(reconcileChat(prev, { ...base, id: 12, isAuthor: true, clientId: "c1" })).toBe(prev);
  });

  it("他人のメッセージは末尾に追加", () => {
    expect(reconcileChat([pending("c1")], { ...base, id: 13 }).map((m) => m.id)).toEqual([-1, 13]);
  });

  it("失敗 → 再送で pending に戻る", () => {
    const failed = markChatFailed([pending("c1")], "c1");
    expect(failed[0]).toMatchObject({ pending: false, failed: true });
    expect(markChatRetrying(failed, "c1")[0]).toMatchObject({ pending: true, failed: false });
  });

  it("client id はサーバーの形式に合い、temp id は負で一意", () => {
    expect(normalizeClientId(newChatClientId())).not.toBeNull();
    const a = newChatTempId();
    const b = newChatTempId();
    expect(a).toBeLessThan(0);
    expect(a).not.toBe(b);
  });
});

describe("送信本文・client_id の検証", () => {
  it("空・長すぎは拒否、CRLF は LF に", () => {
    expect(normalizeChatBody("  ")).toEqual({ ok: false, error: "empty" });
    expect(normalizeChatBody("x".repeat(CHAT_MAX_BODY + 1))).toEqual({ ok: false, error: "too long" });
    expect(normalizeChatBody(" a\r\nb ")).toEqual({ ok: true, body: "a\nb" });
  });
  it("client_id は英数・_- の 64 文字まで", () => {
    expect(normalizeClientId("abc-123_X")).toBe("abc-123_X");
    expect(normalizeClientId("x".repeat(65))).toBeNull();
    expect(normalizeClientId("<script>")).toBeNull();
    expect(normalizeClientId(42)).toBeNull();
  });
});

describe("agent チャット DTO", () => {
  const viewer = { userId: "uid_me", mentionNames: mentionNamesFor(["ドリキン"], "drikin@example.com") };

  it("is_author は authorId で判定し、client_id は本人にだけ返す", () => {
    const mine = toAgentChatDto({ ...base, id: 1, authorId: "uid_me", isAuthor: undefined, clientId: "c1" }, viewer);
    expect(mine.is_author).toBe(true);
    expect(mine.client_id).toBe("c1");
    const other = toAgentChatDto({ ...base, id: 2, isAuthor: undefined, clientId: "c9" }, viewer);
    expect(other.is_author).toBe(false);
    expect(other.client_id).toBeUndefined();
  });

  it("mentions_me は表示名・ブラケット記法・メールのローカル部で反応し、自分の発言では立たない", () => {
    for (const body of ["@ドリキン 見て", "@[ドリ キン] どう？", "@drikin おーい"]) {
      expect(toAgentChatDto({ ...base, id: 3, body, isAuthor: undefined }, viewer).mentions_me).toBe(true);
    }
    expect(toAgentChatDto({ ...base, id: 4, body: "ドリキンさん", isAuthor: undefined }, viewer).mentions_me).toBe(false);
    expect(
      toAgentChatDto({ ...base, id: 5, authorId: "uid_me", body: "@ドリキン", isAuthor: undefined }, viewer).mentions_me
    ).toBe(false);
  });

  it("DTO にメールアドレスを含めない", () => {
    const dto = toAgentChatDto({ ...base, id: 6, isAuthor: undefined }, viewer);
    expect(JSON.stringify(dto)).not.toContain("@example.com");
  });

  it("isMentionedIn は Web と同じ判定（全角スペース無視）", () => {
    expect(isMentionedIn("@[柳家　三之助]", new Set(["柳家三之助"]))).toBe(true);
  });
});

describe("個人ストリームへの変換", () => {
  const viewer = { userId: "uid_me", mentionNames: new Set<string>() };
  it("chat create/edit/delete と presence だけを流す", () => {
    expect(liveToStreamEvent({ type: "chat", action: "delete", message: { id: 9 } }, viewer)).toEqual({
      event: "chat",
      data: { action: "delete", id: 9 },
    });
    const c = liveToStreamEvent({ type: "chat", action: "create", message: { ...base, id: 9 } }, viewer);
    expect(c?.event).toBe("chat");
    expect(liveToStreamEvent({ type: "presence", userIds: ["u1"] }, viewer)).toEqual({
      event: "presence",
      data: { user_ids: ["u1"] },
    });
    expect(liveToStreamEvent({ type: "post", postId: 1, action: "create" }, viewer)).toBeNull();
  });
});

describe("capabilities", () => {
  it("トークンのスコープで操作可否が変わり、presence に影響しないと明示する", () => {
    const ro = agentCapabilities(["read"]);
    expect(ro.apiVersion).toBe(1);
    expect(ro.features.chat).toMatchObject({ read: true, send: false, reactions: false, mark_read: false });
    expect(ro.features.stream.affects_presence).toBe(false);
    const full = agentCapabilities(["read", "read_state", "chat"]);
    expect(full.features.chat).toMatchObject({ send: true, edit_own: true, reactions: true, mark_read: true, ttl_hours: 24 });
  });
});

describe("mentionToken（返信で入れる @名前）", () => {
  it("空白を含む名前は @[...]、それ以外は @名前。どちらも判定で本人に当たる", () => {
    expect(mentionToken("mazzo")).toBe("@mazzo ");
    expect(mentionToken("NORIO TAKAHASHI")).toBe("@[NORIO TAKAHASHI] ");
    expect(isMentionedIn(mentionToken("NORIO TAKAHASHI") + "どうも", mentionNamesFor(["NORIO TAKAHASHI"], null))).toBe(true);
    expect(isMentionedIn(mentionToken("ポンコツ散財王ドリキン") + "了解", mentionNamesFor(["ポンコツ散財王ドリキン"], null))).toBe(true);
  });
});
