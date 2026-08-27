import { describe, it, expect } from "vitest";
import {
  CLUBS,
  CLUB_KEYS,
  CLUB_UNSET,
  clubLabel,
  parseClubOutput,
  buildClubFewShot,
  type ClubExample,
} from "../club-catalog";

// parseClubOutput: モデル出力 → 部活キーの正規化・検証（ハルシネーション除外が最重要）

describe("clubs: CLUBS / CLUB_KEYS", () => {
  it("全ての部活が一意な英字キーを持つ", () => {
    expect(CLUBS.length).toBeGreaterThanOrEqual(27);
    const keys = CLUBS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length); // 重複なし
    for (const c of CLUBS) expect(CLUB_KEYS.has(c.key)).toBe(true);
  });

  it("clubLabel は既知キーの日本語名を返し、未知は null", () => {
    expect(clubLabel("car")).toBe("車部");
    expect(clubLabel("camera")).toBe("カメラ部");
    expect(clubLabel("galaxyfold")).toBe("ギャラクシーフォールド部");
    expect(clubLabel("banana")).toBeNull();
    expect(clubLabel(null)).toBeNull();
  });
});

describe("parseClubOutput", () => {
  it("有効なキーをそのまま返す", () => {
    expect(parseClubOutput("car")).toBe("car");
    expect(parseClubOutput("camera")).toBe("camera");
    expect(parseClubOutput("printer3d")).toBe("printer3d");
    expect(parseClubOutput("galaxyfold")).toBe("galaxyfold");
  });

  it("大文字・前後空白・余分な装飾を正規化する", () => {
    expect(parseClubOutput(" CAR ")).toBe("car");
    expect(parseClubOutput("Car")).toBe("car");
    expect(parseClubOutput("- car")).toBe("car");
    expect(parseClubOutput("* car")).toBe("car");
    expect(parseClubOutput("`car`")).toBe("car");
    expect(parseClubOutput("'car'")).toBe("car");
    expect(parseClubOutput("car\n")).toBe("car");
    expect(parseClubOutput("car\nもう一行")).toBe("car"); // 複数行は1行目
  });

  it("ハルシネーション・無効値は null（最も重要）", () => {
    expect(parseClubOutput("car部")).toBeNull(); // 日本語名混在
    expect(parseClubOutput("車部")).toBeNull(); // key でなく日本語
    expect(parseClubOutput("カメラ")).toBeNull();
    expect(parseClubOutput("toyota")).toBeNull();
    expect(parseClubOutput("supercar")).toBeNull();
    expect(parseClubOutput("car club")).toBeNull(); // 複数語キーは無い
    expect(parseClubOutput("none")).toBeNull(); // none はキーでない→ラベルなし
    expect(parseClubOutput("")).toBeNull();
    expect(parseClubOutput(null)).toBeNull();
    expect(parseClubOutput(undefined)).toBeNull();
  });

  it("存在しない部活（一覧外）は絶対に通さない", () => {
    // 一覧にある全キーは通るはず
    for (const key of CLUB_KEYS) {
      expect(parseClubOutput(key)).toBe(key);
    }
  });

  it("表示順の先頭3つは 雑談→機能改善→バグ報告（drikin指定）", () => {
    const order = CLUBS.map((c) => c.key);
    expect(order.slice(0, 3)).toEqual(["chat", "improve", "bug"]);
    expect(CLUBS.length).toBeGreaterThanOrEqual(28);
    // 機能改善(improve)は有効な分類キーとして扱われる
    expect(parseClubOutput("improve")).toBe("improve");
    expect(clubLabel("improve")).toBe("機能改善");
  });
});

describe("buildClubFewShot（自己学習用 few-shot 例の整形）", () => {
  const ex = (text: string, club: string, manual = false): ClubExample => ({ text, club, manual });

  it("人力で設定された正解(manual)を先頭に優先する", () => {
    const out = buildClubFewShot([
      ex("キーボードの話", "pc", false),
      ex("美味しいラーメン", "gourmet", true),
    ]);
    const gourmetIdx = out.indexOf("ラベル: gourmet");
    const pcIdx = out.indexOf("ラベル: pc");
    expect(gourmetIdx).toBeGreaterThan(-1);
    expect(pcIdx).toBeGreaterThan(-1);
    expect(gourmetIdx).toBeLessThan(pcIdx); // 人力が先
    expect(out).toContain("人力で設定された正解ラベル");
    const markerCount = (out.match(/人力で設定された正解ラベル/g) || []).length;
    expect(markerCount).toBe(1); // 人力は1個目だけに付く
  });

  it("部活ごとの上限 perClub で偏りを抑える", () => {
    const out = buildClubFewShot(
      [
        ex("車A", "car", true),
        ex("車B", "car", true),
        ex("車C", "car", false),
        ex("旅A", "travel", true),
      ],
      { perClub: 2 }
    );
    const carCount = (out.match(/ラベル: car/g) || []).length;
    expect(carCount).toBe(2); // 3個渡しても perClub=2 で2個まで
    expect(out).toContain("ラベル: travel");
  });

  it("全体上限 maxTotal で抑える（token 有界）", () => {
    const many: ClubExample[] = Array.from({ length: 12 }, (_, i) =>
      ex(`投稿${i}`, i % 2 ? "pc" : "car", true)
    );
    const out = buildClubFewShot(many, { maxTotal: 6, perClub: 10 });
    const count = (out.match(/例\d+/g) || []).length;
    expect(count).toBe(6);
  });

  it("markdown を剥がし・空白をまとめ・snippetLen で切り詰める", () => {
    const long = "あ".repeat(200);
    const out = buildClubFewShot([ex(`## 見出し\n本文です  \n改行**太字**\n\`\`\`\ncode\n\`\`\`残り${long}`, "ai")], {
      snippetLen: 40,
    });
    expect(out).not.toMatch(/```/);
    expect(out).not.toMatch(/##/);
    expect(out).not.toMatch(/[ \n]{2,}/);
    // ラベル行の前の本文は40字以内
    const body = out.split("\nラベル:")[0];
    expect(body.replace(/[^\u3040-\u30ff\u4e00-\u9faf]/g, "").length).toBeLessThanOrEqual(40);
  });

  it("空・記号のみ・件数0 は空文字を返す（注入しない）", () => {
    expect(buildClubFewShot([])).toBe("");
    expect(buildClubFewShot([ex("", "car"), ex("```\n```", "pc")])).toBe("");
  });

  it("未設定(CLUB_UNSET)は学習例に含めない（AI に未設定を出力させない）", () => {
    const out = buildClubFewShot([ex("どうでもいい話", CLUB_UNSET, true), ex("本物のカメラ話", "camera", true)]);
    expect(out).not.toContain(CLUB_UNSET);
    expect(out).toContain("ラベル: camera");
  });
});

describe("club-catalog: 雑談 / 未設定", () => {
  it("雑談(chat)は実クラブとして一覧に含まれる", () => {
    expect(CLUBS.some((c) => c.key === "chat" && c.name === "雑談")).toBe(true);
    expect(CLUB_KEYS.has("chat")).toBe(true);
    expect(clubLabel("chat")).toBe("雑談");
    expect(parseClubOutput("chat")).toBe("chat");
  });

  it("未設定(CLUB_UNSET)は CLUB_KEYS に含まれず、AI には出力できない", () => {
    expect(CLUB_KEYS.has(CLUB_UNSET)).toBe(false);
    expect(clubLabel(CLUB_UNSET)).toBe("未設定"); // 表示は「未設定」
    expect(parseClubOutput(CLUB_UNSET)).toBeNull(); // parseClubOutput は絶対に通さない
  });
});
