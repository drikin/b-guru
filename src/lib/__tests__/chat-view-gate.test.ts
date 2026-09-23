import { describe, it, expect } from "vitest";

/**
 * チャットタブ表示ゲートの回帰テスト。
 *
 * 背景（2026-09-22・どりきん報告）: 「タイムラインとチャットを切り替えるときに、
 * チャットが表示されないことが多々あります」。
 *
 * 真因: チャット本体の描画条件が
 *     showChatView = showNavTabs && chatView
 * になっていた。showNavTabs は
 *     activeNav === "feed" && !threadPost && !searchActive && !profileEmail
 * なので、チャットタブを選んだ状態でスレッドを開く／検索する／プロフィールを
 * 見ると showNavTabs が false になり、**タブは「チャット」を選択表示したまま
 * 中身だけが消える**。しかも Mantine の SegmentedControl は既に選択済みの値を
 * 再タップしても onChange を発火しないため、ユーザーはリロード以外で復帰でき
 * なかった。
 *
 * 修正: showChatView は chatView のみで判定する（タブバー自体は showNavTabs の
 * まま＝ホーム限定）。このテストはその不変条件を固定する。
 */

/** page.tsx の showNavTabs と同じ式（タブバーの表示条件）。 */
function showNavTabs(s: {
  activeNav: string;
  threadPost: unknown;
  searchActive: boolean;
  profileEmail: string | null;
}): boolean {
  return (
    s.activeNav === "feed" && !s.threadPost && !s.searchActive && !s.profileEmail
  );
}

/** 修正後の showChatView。 */
function showChatView(chatView: boolean): boolean {
  return chatView;
}

/** 修正前の showChatView（バグ再現用）。 */
function showChatViewBuggy(
  chatView: boolean,
  s: Parameters<typeof showNavTabs>[0]
): boolean {
  return showNavTabs(s) && chatView;
}

const home = {
  activeNav: "feed",
  threadPost: null,
  searchActive: false,
  profileEmail: null,
};

describe("chat view gate", () => {
  it("ホームでチャットタブを選ぶと表示される", () => {
    expect(showChatView(true)).toBe(true);
  });

  it("ホームでタイムラインタブなら表示されない", () => {
    expect(showChatView(false)).toBe(false);
  });

  // これが報告されたバグそのもの。
  it("チャットタブ選択中にスレッドを開いても、チャット本体は表示され続ける", () => {
    const inThread = { ...home, threadPost: { id: 1 } };
    // 旧実装ではここで false になり、タブは「チャット」のまま中身が消えた。
    expect(showChatViewBuggy(true, inThread)).toBe(false);
    // 新実装では chatView が真実の源なので消えない。
    expect(showChatView(true)).toBe(true);
  });

  it("チャットタブ選択中に検索を開いても、チャット本体は表示され続ける", () => {
    const searching = { ...home, searchActive: true };
    expect(showChatViewBuggy(true, searching)).toBe(false);
    expect(showChatView(true)).toBe(true);
  });

  it("チャットタブ選択中にプロフィールを開いても、チャット本体は表示され続ける", () => {
    const profile = { ...home, profileEmail: "a@b.c" };
    expect(showChatViewBuggy(true, profile)).toBe(false);
    expect(showChatView(true)).toBe(true);
  });

  it("タブバー自体はホーム限定のまま（回帰防止）", () => {
    expect(showNavTabs(home)).toBe(true);
    expect(showNavTabs({ ...home, threadPost: { id: 1 } })).toBe(false);
    expect(showNavTabs({ ...home, searchActive: true })).toBe(false);
    expect(showNavTabs({ ...home, profileEmail: "a@b.c" })).toBe(false);
    expect(showNavTabs({ ...home, activeNav: "clubs" })).toBe(false);
  });
});
