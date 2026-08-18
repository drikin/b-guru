/* ビーグルエージェント: 学習（メンション・フィードバック → memory.md 更新） */
import { appendMemory, loadMemoryMd, memoryBytes } from "./files";

/** 文字bigram集合に分解（日本語文の類似度判定用） */
function bigrams(s: string): Set<string> {
  const norm = s.replace(/\s+/g, "").replace(/[、。！？・「」『』（）()\-]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) {
    out.add(norm.slice(i, i + 2));
  }
  return out;
}

/** Sørensen–Dice 類似度（0.0〜1.0）。日本語の言い換え対も Jaccard より敏感に検出。 */
function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const denom = A.size + B.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

/**
 * 学びの配列から、既存メモのバレット（existing）や配列内で相互に 55% 以上似ているものを
 * 除外した「新規の学び」だけを返す（ハードガード・純関数・テスト対象）。
 */
export function dedupeLearnings(learnings: string[], existing: string[]): string[] {
  const acc: string[] = [];
  const pool = existing.slice();
  for (const l of (learnings || []).map((x) => String(x).trim()).filter((x) => x.length > 0)) {
    const dup =
      pool.some((e) => dice(e, l) >= 0.55) || acc.some((f) => dice(f, l) >= 0.55);
    if (!dup) {
      pool.push(l);
      acc.push(l);
    }
  }
  return acc;
}

/**
 * 学びの配列を memory.md に追記する。ただし:
 * - 既存メモのバレットと 55% 以上似ている学びは重複とみなし削る（ハードガード）
 * - 配列内で相互に重複する学びも1つに絞る
 * 必要なら自己圧縮する。
 */
export async function applyLearnings(
  learnings: string[]
): Promise<{ bytesBefore: number; bytesAfter: number; compacted: boolean }> {
  const bytesBefore = await memoryBytes();
  const useful = (learnings || []).map((l) => String(l).trim()).filter((l) => l.length > 0);
  if (useful.length === 0) return { bytesBefore, bytesAfter: bytesBefore, compacted: false };

  // 既存メモの一覧（`- 本文` 形式のバレット）を抽出
  const existing = (await loadMemoryMd())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^-/.test(l))
    .map((l) => l.replace(/^-\s*/, ""));

  // ハードガード: 既存メモと重複する学び・配列内で互いに重複する学びを除去
  const fresh = dedupeLearnings(useful, existing);

  if (fresh.length === 0) return { bytesBefore, bytesAfter: bytesBefore, compacted: false };

  const { bytes, compacted } = await appendMemory(fresh.join("\n"));
  return { bytesBefore, bytesAfter: bytes, compacted };
}
