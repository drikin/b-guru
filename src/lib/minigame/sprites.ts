/* 🎮 締め切りダッシュ — ドット絵の窓口。
 * 正本はドット絵担当の sprites.generated.ts（scripts/minigame-sprites.py が作る。ここからは書き換えない）。
 * そこに無い名前・コマは、v2 で足した物なら sprites.extra.ts、それ以外は sprites.placeholder.ts の仮の絵で埋める。
 * どちらもパレットが違うので、1 枚ごとに自分のパレットを持たせて返す。 */
import * as G from "./sprites.generated";
import * as P from "./sprites.placeholder";
import * as X from "./sprites.extra";

export type Sprite = { w: number; h: number; frames: Record<string, string[]>; palette: string[]; source: "generated" | "extra" | "placeholder" };

/** ゲームが使う名前と、それぞれに要るコマ。 */
export const NEEDED: Record<string, string[]> = {
  drikin: ["run1", "run2", "jump", "hit"],
  matsuo: ["run1", "run2", "jump", "hit"],
  zenji: ["run1", "run2", "jump", "hit"],
  beagle: ["run1", "run2", "sit"],
  drikin_big: ["idle"],
  matsuo_big: ["idle"],
  zenji_big: ["idle"],
  beagle_big: ["idle"],
  xlr: [],
  micstand: [],
  box: [],
  bill: [],
  deadline: [],
  sdcard: [],
  coffee: [],
  reclamp: [],
  money: [],
  floor: [],
  city1: [],
  city2: [],
  // v2: 跳んではいけない障害物（ドット絵担当の生成ファイルに無ければ sprites.extra.ts）
  drone: ["f1", "f2"],
  boommic: [],
};

function valid(sp: unknown, need: string[]): sp is { w: number; h: number; frames: Record<string, string[]> } {
  if (!sp || typeof sp !== "object") return false;
  const s = sp as { w?: unknown; h?: unknown; frames?: unknown };
  if (typeof s.w !== "number" || typeof s.h !== "number" || !s.frames || typeof s.frames !== "object") return false;
  const frames = s.frames as Record<string, unknown>;
  const names = Object.keys(frames);
  if (names.length === 0) return false;
  for (const n of need) if (!Array.isArray(frames[n])) return false;
  return names.every((n) => Array.isArray(frames[n]) && (frames[n] as unknown[]).length > 0);
}

function build(): Record<string, Sprite> {
  const gen = (G as { SPRITES?: Record<string, unknown> }).SPRITES ?? {};
  const genPal = (G as { PALETTE?: string[] }).PALETTE ?? [];
  const out: Record<string, Sprite> = {};
  for (const [name, need] of Object.entries(NEEDED)) {
    const g = gen[name];
    const x = X.SPRITES[name];
    if (valid(g, need) && genPal.length > 0) out[name] = { ...g, palette: genPal, source: "generated" };
    else if (x && valid(x, need)) out[name] = { ...x, palette: X.PALETTE, source: "extra" };
    else out[name] = { ...P.SPRITES[name], palette: P.PALETTE, source: "placeholder" };
  }
  return out;
}

export const SPRITE_SET: Record<string, Sprite> = build();

/** 仮の絵で埋めた名前（テスト・確認用）。 */
export function placeholderNames(): string[] {
  return Object.entries(SPRITE_SET)
    .filter(([, s]) => s.source === "placeholder")
    .map(([n]) => n);
}
