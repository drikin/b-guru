import { describe, it, expect } from "vitest";
import {
  CLUBS,
  CLUB_KEYS,
  clubLabel,
  parseClubOutput,
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
});
