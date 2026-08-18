/* ビーグルエージェント: 学習（メンション・フィードバック → memory.md 更新） */
import { appendMemory, memoryBytes } from "./files";

/** 学びの配列を memory.md に追記し、必要なら自己圧縮する。 */
export async function applyLearnings(
  learnings: string[]
): Promise<{ bytesBefore: number; bytesAfter: number; compacted: boolean }> {
  const bytesBefore = await memoryBytes();
  const useful = (learnings || []).map((l) => String(l).trim()).filter((l) => l.length > 0);
  if (useful.length === 0) return { bytesBefore, bytesAfter: bytesBefore, compacted: false };

  const { bytes, compacted } = await appendMemory(useful.join("\n"));
  return { bytesBefore, bytesAfter: bytes, compacted };
}
