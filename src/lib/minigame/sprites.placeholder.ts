/* 🎮 散財ダッシュ — 仮のドット絵（sprites.generated.ts と同じ形）。
 * ドット絵担当の生成ファイル（scripts/minigame-sprites.py → sprites.generated.ts）に無い名前・コマだけ、
 * sprites.ts がこちらで埋める。形は 1 文字 = 1 ドット、"." 透明、"0-9a-z" は PLACEHOLDER_PALETTE の索引。 */

export const PALETTE: string[] = [
  "#120e14", // 0 night
  "#fdf0d2", // 1 paper
  "#dc4a3f", // 2 red
  "#3ccf74", // 3 green
  "#4bacc6", // 4 sky
  "#f2b24c", // 5 amber
  "#8a8a96", // 6 gray
  "#a8784f", // 7 wood
  "#f1c7a0", // 8 skin
  "#2b1d3a", // 9 plum
  "#5b3f7a", // a violet
];

type Sprite = { w: number; h: number; frames: Record<string, string[]> };

function grid(w: number, h: number, f: (x: number, y: number) => string): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = "";
    for (let x = 0; x < w; x++) r += f(x, y);
    rows.push(r);
  }
  return rows;
}

/** 16×16 の人（頭・胴・足。服の色 c、足の形で走りのコマ）。 */
function person(c: string, pose: "run1" | "run2" | "jump" | "hit"): string[] {
  return grid(16, 16, (x, y) => {
    if (y >= 1 && y <= 5 && x >= 5 && x <= 10) return pose === "hit" && (x === 6 || x === 9) && y === 3 ? "0" : "8";
    if (y >= 6 && y <= 11 && x >= 4 && x <= 11) return c;
    if (y >= 12) {
      const legA = pose === "run1" ? [5, 6] : pose === "run2" ? [7, 8] : [5, 6, 9, 10];
      const legB = pose === "run1" ? [9, 10] : pose === "run2" ? [6, 7] : [];
      if (pose === "jump" && y > 13) return ".";
      if (legA.includes(x) || legB.includes(x)) return "0";
    }
    return ".";
  });
}

function big(c: string): string[] {
  return grid(32, 32, (x, y) => {
    if (y >= 2 && y <= 12 && x >= 10 && x <= 21) return "8";
    if (y >= 13 && y <= 25 && x >= 8 && x <= 23) return c;
    if (y >= 26 && (x === 11 || x === 12 || x === 19 || x === 20)) return "0";
    return ".";
  });
}

function box(w: number, h: number, c: string, border = "0"): string[] {
  return grid(w, h, (x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? border : c));
}

export const SPRITES: Record<string, Sprite> = {
  drikin: { w: 16, h: 16, frames: { run1: person("2", "run1"), run2: person("2", "run2"), jump: person("2", "jump"), hit: person("2", "hit") } },
  matsuo: { w: 16, h: 16, frames: { run1: person("4", "run1"), run2: person("4", "run2"), jump: person("4", "jump"), hit: person("4", "hit") } },
  zenji: { w: 16, h: 16, frames: { run1: person("3", "run1"), run2: person("3", "run2"), jump: person("3", "jump"), hit: person("3", "hit") } },
  beagle: {
    w: 16,
    h: 16,
    frames: {
      run1: grid(16, 16, (x, y) => (y >= 7 && y <= 12 && x >= 3 && x <= 13 ? (x > 10 && y < 9 ? "7" : "1") : y > 12 && (x === 4 || x === 12) ? "7" : ".")),
      run2: grid(16, 16, (x, y) => (y >= 7 && y <= 12 && x >= 3 && x <= 13 ? (x > 10 && y < 9 ? "7" : "1") : y > 12 && (x === 6 || x === 10) ? "7" : ".")),
      sit: grid(16, 16, (x, y) => (y >= 5 && y <= 15 && x >= 5 && x <= 11 ? (y < 8 ? "7" : "1") : ".")),
    },
  },
  drikin_big: { w: 32, h: 32, frames: { idle: big("2") } },
  matsuo_big: { w: 32, h: 32, frames: { idle: big("4") } },
  zenji_big: { w: 32, h: 32, frames: { idle: big("3") } },
  beagle_big: { w: 32, h: 32, frames: { idle: grid(32, 32, (x, y) => (y >= 10 && x >= 6 && x <= 26 ? (y < 16 ? "7" : "1") : ".")) } },
  xlr: { w: 32, h: 16, frames: { idle: grid(32, 16, (x, y) => (y === 12 + ((x >> 2) & 1) || y === 13 + ((x >> 2) & 1) ? "6" : ".")) } },
  micstand: { w: 16, h: 32, frames: { idle: grid(16, 32, (x, y) => (y < 5 && x >= 9 && x <= 13 ? "6" : (x === 7 || x === 8) && y >= 4 ? "6" : y === 31 && x >= 3 && x <= 12 ? "6" : ".")) } },
  box: { w: 16, h: 16, frames: { idle: box(16, 16, "7") } },
  bill: { w: 16, h: 16, frames: { idle: grid(16, 16, (x, y) => (x >= 2 && x <= 13 && y >= 1 && y <= 14 ? (y % 3 === 0 && x > 3 && x < 12 ? "6" : "1") : ".")) } },
  deadline: { w: 16, h: 16, frames: { idle: grid(16, 16, (x, y) => (((x + y) & 7) < 4 ? "2" : "9")) } },
  sdcard: { w: 12, h: 12, frames: { idle: box(12, 12, "4", "1") } },
  coffee: { w: 12, h: 12, frames: { idle: box(12, 12, "7", "1") } },
  reclamp: { w: 12, h: 12, frames: { idle: box(12, 12, "2", "1") } },
  money: { w: 12, h: 12, frames: { idle: box(12, 12, "5", "0") } },
  floor: { w: 16, h: 16, frames: { idle: grid(16, 16, (x, y) => (y === 0 ? "5" : (y & 3) === 0 ? "9" : "a")) } },
  city1: { w: 64, h: 48, frames: { idle: grid(64, 48, (x, y) => (y > 16 + ((x >> 3) % 3) * 6 ? ((x & 7) === 3 && (y & 7) === 3 ? "5" : "9") : ".")) } },
  city2: { w: 64, h: 48, frames: { idle: grid(64, 48, (x, y) => (y > 24 + ((x >> 4) & 1) * 8 ? "a" : ".")) } },
};
