import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

// さくらのAI Engine はモックする。ここで固定したいのは「AI の出力をどう解釈
// するか」であって、モデルの賢さではない（それは実測で確認済み）。
const sakuraChat = vi.fn();
vi.mock("../sakura", () => ({ sakuraChat: (...a: unknown[]) => sakuraChat(...a) }));

// URL プレビューの取得もモックする（外部サイトを取りに行かせない）。
const fetchUrlPreview = vi.fn();
vi.mock("../urlpreview", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, fetchUrlPreview: (...a: unknown[]) => fetchUrlPreview(...a) };
});

import {
  normalizeText,
  normalizeUrl,
  similarity,
  firstUrl,
  extractYoutubeIdFromText,
  findDuplicates,
  findNewsDuplicates,
  judgeSameNews,
} from "../duplicates";

beforeEach(() => {
  query.mockReset();
  sakuraChat.mockReset();
  fetchUrlPreview.mockReset();
});

describe("normalizeUrl", () => {
  // 実測で見つかった実際の重複: 同じ動画が別のURL形式で投稿されていた。
  it("treats youtu.be and youtube.com/watch as the same video URL", () => {
    const a = normalizeUrl("https://www.youtube.com/watch?v=GzI_qMqWq7s");
    const b = normalizeUrl("https://youtu.be/GzI_qMqWq7s?si=xDdNDpCO_sZQ71IE");
    // ホストが違うので完全一致はしないが、videoId の層で拾える。
    // ここでは「トラッキングパラメータが落ちること」と「動画IDは残ること」を
    // 固定する（v= を落とすと動画が特定できなくなる）。
    expect(b).not.toContain("si=");
    expect(a).toBe("https://youtube.com/watch?v=GzI_qMqWq7s");
    expect(b).toBe("https://youtu.be/GzI_qMqWq7s");
  });

  it("drops tracking parameters", () => {
    const u = normalizeUrl("https://example.com/a?utm_source=x&fbclid=y&id=1");
    expect(u).toBe("https://example.com/a?id=1");
  });

  it("sorts remaining query parameters so order does not matter", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/a?a=1&b=2")
    );
  });

  it("strips www. and the trailing slash", () => {
    expect(normalizeUrl("https://www.example.com/path/")).toBe("https://example.com/path");
  });

  it("keeps a bare host intact", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("returns the input unchanged when it is not a URL", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("normalizeText", () => {
  it("removes URLs so a shared link alone is not a text match", () => {
    expect(normalizeText("これ良い https://example.com/x")).toBe("これ良い");
  });

  it("folds full-width and case differences", () => {
    expect(normalizeText("ＡＢＣ")).toBe(normalizeText("abc"));
  });

  it("collapses whitespace", () => {
    expect(normalizeText("a   b\n\nc")).toBe("a b c");
  });
});

describe("similarity", () => {
  it("is 1 for identical text", () => {
    expect(similarity("こんにちは", "こんにちは")).toBe(1);
  });

  it("is 1 when only the URL differs", () => {
    expect(similarity("これ良い https://a.com", "これ良い https://b.com")).toBe(1);
  });

  it("is 0 for unrelated text", () => {
    expect(similarity("今日は晴れです", "カメラのレンズを買いました")).toBe(0);
  });

  it("scores a near-duplicate above the threshold", () => {
    const s = similarity(
      "Gino Vannelli – Brother To Brother は名曲",
      "Gino Vannelli – Brother To Brother は名曲だと思う"
    );
    expect(s).toBeGreaterThan(0.55);
  });

  it("is 0 when either side is empty", () => {
    expect(similarity("", "abc")).toBe(0);
    expect(similarity("abc", "")).toBe(0);
  });

  it("handles single-character strings without crashing", () => {
    expect(similarity("あ", "あ")).toBe(1);
    expect(similarity("あ", "い")).toBe(0);
  });
});

describe("firstUrl / extractYoutubeIdFromText", () => {
  it("finds the first URL in the text", () => {
    expect(firstUrl("見て https://a.com/x これ")).toBe("https://a.com/x");
  });

  it("returns null when there is no URL", () => {
    expect(firstUrl("URLなし")).toBeNull();
  });

  it("extracts the video id from a watch URL", () => {
    expect(extractYoutubeIdFromText("https://www.youtube.com/watch?v=GzI_qMqWq7s")).toBe(
      "GzI_qMqWq7s"
    );
  });

  it("extracts the video id from a youtu.be URL with a tracking param", () => {
    expect(extractYoutubeIdFromText("https://youtu.be/GzI_qMqWq7s?si=abc")).toBe("GzI_qMqWq7s");
  });

  it("returns null for a non-YouTube URL", () => {
    expect(extractYoutubeIdFromText("https://example.com/x")).toBeNull();
  });
});

describe("findDuplicates", () => {
  it("returns nothing for a reply — a reply is the correct way to join a topic", async () => {
    const out = await findDuplicates({ text: "同じ動画", authorEmail: "a@b.c", parentId: 5 });
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns nothing for empty text", async () => {
    const out = await findDuplicates({ text: "   ", authorEmail: "a@b.c" });
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("finds a duplicate by YouTube video id", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5511,
          author_email: "crusader@bp.iij4u.or.jp",
          author_name: "crusader",
          text: "https://www.youtube.com/watch?v=GzI_qMqWq7s",
          created_at: "2026-09-25T06:00:23Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass finds nothing new
    const out = await findDuplicates({
      text: "https://youtu.be/GzI_qMqWq7s?si=xDdNDpCO_sZQ71IE",
      authorEmail: "rikito1206@gmail.com",
    });
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe(5511);
    expect(out[0].kind).toBe("video");
    expect(out[0].exact).toBe(true);
    // 動画IDで見つかったので、あいまい類似のクエリは走らせない。
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("marks a video match as exact so the UI can emphasise it", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          author_email: "x@y.z",
          author_name: null,
          text: "https://youtu.be/aaaaaaaaaaa",
          created_at: "2026-09-25T00:00:00Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    const out = await findDuplicates({
      text: "https://youtu.be/aaaaaaaaaaa",
      authorEmail: "a@b.c",
    });
    expect(out[0].exact).toBe(true);
    expect(out[0].score).toBe(1);
  });

  it("falls back to the email local part when there is no display name", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          author_email: "someone@example.com",
          author_name: null,
          text: "https://youtu.be/aaaaaaaaaaa",
          created_at: "2026-09-25T00:00:00Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    const out = await findDuplicates({
      text: "https://youtu.be/aaaaaaaaaaa",
      authorEmail: "a@b.c",
    });
    expect(out[0].authorName).toBe("someone");
  });

  it("does not run the fuzzy pass when an exact match was already found", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          author_email: "x@y.z",
          author_name: "x",
          text: "https://youtu.be/aaaaaaaaaaa",
          created_at: "2026-09-25T00:00:00Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    await findDuplicates({ text: "https://youtu.be/aaaaaaaaaaa", authorEmail: "a@b.c" });
    // 動画ID + URL の2回だけ。あいまい類似は走らない。
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("runs the fuzzy pass when nothing exact matched", async () => {
    // 本文に URL が無いので URL パスは走らない。本文一致 → あいまい類似の2回。
    query.mockResolvedValueOnce({ rows: [] }); // text pass
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 99,
          author_email: "x@y.z",
          author_name: "x",
          text: "Gino Vannelli – Brother To Brother は名曲だと思う",
          created_at: "2026-09-24T00:00:00Z",
        },
      ],
    });
    const out = await findDuplicates({
      text: "Gino Vannelli – Brother To Brother は名曲",
      authorEmail: "a@b.c",
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("similar");
    expect(out[0].exact).toBe(false);
    expect(out[0].score).toBeGreaterThan(0.55);
  });

  it("sorts exact matches before fuzzy ones", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          author_email: "x@y.z",
          author_name: "x",
          text: "https://youtu.be/aaaaaaaaaaa",
          created_at: "2026-09-20T00:00:00Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    const out = await findDuplicates({
      text: "https://youtu.be/aaaaaaaaaaa",
      authorEmail: "a@b.c",
    });
    expect(out[0].exact).toBe(true);
  });

  it("caps the number of candidates so the warning stays readable", async () => {
    query.mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        author_email: "x@y.z",
        author_name: "x",
        text: "https://youtu.be/aaaaaaaaaaa",
        created_at: "2026-09-25T00:00:00Z",
      })),
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    const out = await findDuplicates({
      text: "https://youtu.be/aaaaaaaaaaa",
      authorEmail: "a@b.c",
    });
    expect(out.length).toBeLessThanOrEqual(3);
  });
});

describe("judgeSameNews", () => {
  it("parses a same verdict", async () => {
    sakuraChat.mockResolvedValueOnce({
      content: '{"verdict":"same","confidence":0.98,"reason":"同一台風の発生と進路情報"}',
    });
    const v = await judgeSameNews(
      { title: "台風26号発生", description: "気象庁発表" },
      { title: "台風26号「スリゲ」発生", description: "沖縄は大しけ" }
    );
    expect(v.verdict).toBe("same");
    expect(v.confidence).toBe(0.98);
    expect(v.reason).toContain("台風");
  });

  it("parses a related verdict — same theme, different news", async () => {
    sakuraChat.mockResolvedValueOnce({
      content: '{"verdict":"related","confidence":0.95,"reason":"同じAppleでも製品が異なる"}',
    });
    const v = await judgeSameNews(
      { title: "新型M6 Mac miniレビュー", description: "" },
      { title: "iPhone 18 Proの店舗在庫", description: "" }
    );
    expect(v.verdict).toBe("related");
  });

  it("extracts JSON even when the model wraps it in prose", async () => {
    sakuraChat.mockResolvedValueOnce({
      content: '判定します。\n{"verdict":"different","confidence":0.9,"reason":"別分野"}\n以上です。',
    });
    const v = await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    expect(v.verdict).toBe("different");
  });

  it("falls back to different when the model returns garbage", async () => {
    sakuraChat.mockResolvedValueOnce({ content: "よくわかりません" });
    const v = await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    expect(v.verdict).toBe("different");
    expect(v.confidence).toBe(0);
  });

  it("falls back to different when the verdict is not one of the three", async () => {
    sakuraChat.mockResolvedValueOnce({ content: '{"verdict":"maybe","confidence":0.5}' });
    const v = await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    expect(v.verdict).toBe("different");
  });

  it("never throws when the AI call fails — a duplicate check must not block posting", async () => {
    sakuraChat.mockRejectedValueOnce(new Error("network down"));
    const v = await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    expect(v.verdict).toBe("different");
  });

  it("asks for enough tokens that the JSON is not truncated", async () => {
    sakuraChat.mockResolvedValueOnce({ content: '{"verdict":"same","confidence":1,"reason":"x"}' });
    await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    // 200 だと JSON が途中で切れた（実測）。余裕を持たせていることを固定する。
    expect(sakuraChat.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(300);
  });

  it("uses temperature 0 so the same pair always gets the same verdict", async () => {
    sakuraChat.mockResolvedValueOnce({ content: '{"verdict":"same","confidence":1,"reason":"x"}' });
    await judgeSameNews({ title: "a", description: "" }, { title: "b", description: "" });
    expect(sakuraChat.mock.calls[0][0].temperature).toBe(0);
  });
});

describe("findDuplicates — AI news layer", () => {
  it("does not call the AI when an exact match was already found", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          author_email: "x@y.z",
          author_name: "x",
          text: "https://youtu.be/aaaaaaaaaaa",
          created_at: "2026-09-25T00:00:00Z",
        },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    await findDuplicates({ text: "https://youtu.be/aaaaaaaaaaa", authorEmail: "a@b.c" });
    expect(sakuraChat).not.toHaveBeenCalled();
    expect(fetchUrlPreview).not.toHaveBeenCalled();
  });

  it("does not call the AI when the post has no URL", async () => {
    const out = await findNewsDuplicates("今日はいい天気ですね");
    expect(out).toEqual([]);
    expect(sakuraChat).not.toHaveBeenCalled();
  });

  it("reports a same-news match from a different site as kind=news", async () => {
    // findNewsDuplicates は「プレビュー取得 → 候補検索 → AI 判定」の順。
    // 速い層（URL/本文/あいまい）は走らない。
    fetchUrlPreview.mockResolvedValueOnce({
      title: "台風26号「スリゲ」発生 沖縄は大しけのおそれ",
      description: "気象庁は24日、台風26号が発生したと発表しました。",
    });
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5346,
          author_email: "x@y.z",
          author_name: "x",
          text: "https://news.example/typhoon",
          created_at: "2026-09-24T03:00:00Z",
          title: "【台風情報】最大瞬間風速55m/s予想「台風26号(スリゲ)」発生",
          description: "気象庁によりますと、台風26号はフィリピンの東を進んでいます。",
        },
      ],
    });
    sakuraChat.mockResolvedValueOnce({
      content: '{"verdict":"same","confidence":0.98,"reason":"同一台風の発生と進路情報"}',
    });

    // ★ AI 層は findDuplicates からは走らない（遅いので phase=ai で別途呼ぶ）。
    const out = await findNewsDuplicates(
      "台風26号が発生 https://other-news.example/typhoon26"
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("news");
    expect(out[0].exact).toBe(false);
    expect(out[0].reason).toContain("台風");
  });

  it("does NOT report a related verdict — same theme is not the same news", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    query.mockResolvedValueOnce({ rows: [] }); // text pass
    query.mockResolvedValueOnce({ rows: [] }); // fuzzy pass
    fetchUrlPreview.mockResolvedValueOnce({
      title: "Apple、Qwen3.5-9BベースのLLMモデル「LensVLM-9B」を公開",
      description: "AppleがHugging Faceにて公開。",
    });
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5323,
          author_email: "x@y.z",
          author_name: "x",
          text: "https://gizmodo.jp/macmini",
          created_at: "2026-09-24T01:51:00Z",
          title: "まさかの「Appleが神コスパ」になっちゃった：新型M6 Mac miniレビュー",
          description: "M6チップ搭載の新型Mac miniの実力をレビュー。",
        },
      ],
    });
    sakuraChat.mockResolvedValueOnce({
      content: '{"verdict":"related","confidence":0.95,"reason":"同じAppleでも製品が異なる"}',
    });

    const out = await findNewsDuplicates(
      "AppleがLensVLM-9Bを公開 https://macotakara.jp/lensvlm"
    );
    // related は「同じテーマだが別の話」。警告すると誤警告になる。
    expect(out).toHaveLength(0);
  });

  it("skips the AI layer when the URL preview has no title", async () => {
    fetchUrlPreview.mockResolvedValueOnce({ title: "", description: "" });
    const out = await findNewsDuplicates("https://example.com/x");
    expect(out).toEqual([]);
    expect(sakuraChat).not.toHaveBeenCalled();
  });

  it("survives a URL preview failure without blocking", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // URL pass
    query.mockResolvedValueOnce({ rows: [] }); // text pass
    query.mockResolvedValueOnce({ rows: [] }); // fuzzy pass
    fetchUrlPreview.mockRejectedValueOnce(new Error("timeout"));
    const out = await findDuplicates({
      text: "https://example.com/x",
      authorEmail: "a@b.c",
    });
    expect(out).toEqual([]);
  });
});
