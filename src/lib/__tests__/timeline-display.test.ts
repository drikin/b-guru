/**
 * タイムラインの「表示の判断」（lib/timeline-display.ts）が例題どおりか。
 *
 * 例題: src/lib/__tests__/fixtures/timeline/posts.json（アプリ用 API の投稿の形）と
 *       expected.json（手で書いた期待値。関数の出力をコピーしたものではない）。
 * アプリ側（Swift/Kotlin）のテストも同じ JSON を読み、API の display をそのまま
 * 描けているかを確かめる（docs/timeline-spec.md「例題データ」）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computePostDisplay,
  findMentions,
  findUserLinks,
  foldPoint,
  foldedText,
  highlightMentions,
  imageColumns,
  linkifyUserLinks,
  replyFold,
  sortReactions,
  type DisplayInput,
} from "../timeline-display";

const dir = path.join(__dirname, "fixtures", "timeline");
const fixture = JSON.parse(fs.readFileSync(path.join(dir, "posts.json"), "utf8")) as {
  context: { member_names: string[]; clubs: Record<string, string> };
  posts: (DisplayInput & { id: number })[];
};
const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8")) as {
  displays: Record<string, unknown>;
  reply_fold: { replies: number; hidden: number; visible: number }[];
};
const ctx = {
  memberNames: fixture.context.member_names,
  clubName: (k: string) => fixture.context.clubs[k] ?? null,
};

describe("例題: サーバの判断 == 期待値", () => {
  it("例題は 20 件以上あり、どれにも期待値がある", () => {
    expect(fixture.posts.length).toBeGreaterThanOrEqual(20);
    for (const p of fixture.posts) expect(expected.displays[String(p.id)], `id ${p.id}`).toBeDefined();
  });

  for (const p of fixture.posts) {
    it(`id ${p.id}`, () => {
      expect(computePostDisplay(p, ctx)).toEqual(expected.displays[String(p.id)]);
    });
  }

  it("返信の畳み方（4 件以上で畳み、最新 3 件を出す）", () => {
    for (const c of expected.reply_fold) {
      expect(replyFold(c.replies), `${c.replies} 件`).toEqual({ hidden: c.hidden, visible: c.visible });
    }
  });
});

describe("Web の表示とずれない", () => {
  /** アプリがする描き方（範囲を当てはめる）を、Web の Markdown 前処理の形で再現する。 */
  function applyRanges(text: string, names: string[]): string {
    const ranges = [
      ...findUserLinks(text).map((u) => ({ ...u, kind: "user" as const })),
      ...findMentions(text, names).map((m) => ({ ...m, kind: "mention" as const })),
    ].sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0;
    for (const r of ranges) {
      if (r.start < at) continue;
      out += text.slice(at, r.start);
      if (r.kind === "user") out += `[#/user/${r.user_id}](#/user/${r.user_id})`;
      else {
        const slug = r.name.toLowerCase();
        const bracket = text.slice(r.start, r.start + 2) === "@[";
        out += `[@${r.name}](#mention-${bracket ? slug.replace(/\s+/g, "-") : slug})`;
      }
      at = r.end;
    }
    return out + text.slice(at);
  }

  for (const p of fixture.posts) {
    it(`id ${p.id}: mentions / user_links を当てはめた結果 == Web の highlightMentions(linkifyUserLinks())`, () => {
      const names = fixture.context.member_names;
      const web = highlightMentions(linkifyUserLinks(p.text), names.map((name) => ({ name })));
      expect(applyRanges(p.text, names)).toBe(web);
    });
  }

  it("畳んだ本文は Web の slice と同じ（割れる絵文字の手前だけ 1 つ戻す）", () => {
    const t = "あ".repeat(600);
    expect(foldedText(t, foldPoint(t))).toBe(t.slice(0, 500));
    const e = "a".repeat(499) + "😀" + "b";
    expect(foldedText(e, foldPoint(e))).toBe("a".repeat(499));
    expect(foldPoint("x".repeat(500))).toBeNull();
    expect(foldPoint(null)).toBeNull();
  });

  it("リアクションの並びは元の配列を変えない・同数は UTF-16 順", () => {
    const list = [
      { emoji: "b", count: 1 },
      { emoji: "a", count: 1 },
      { emoji: "z", count: 3 },
    ];
    expect(sortReactions(list).map((r) => r.emoji)).toEqual(["z", "a", "b"]);
    expect(list[0].emoji).toBe("b");
  });

  it("画像の列数", () => {
    expect([0, 1, 2, 3, 4, 5].map(imageColumns)).toEqual([0, 1, 2, 3, 3, 3]);
  });
});
