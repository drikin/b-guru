"use client";

import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import type { DuplicateCandidate } from "@/lib/duplicates";

/**
 * 投稿前の重複警告。
 *
 * drikin 2026-09-25: 「似たような投稿があった時に警告したり、うまくそれを統合
 * したりするような、もうちょっと同じような情報をまとめ上げる仕組みを考えられ
 * ませんかね？」
 *
 * 設計の要点:
 *   - ブロックしない。投稿者の判断を奪わない。
 *   - 「確実な重複」と「あいまい類似」を視覚的に分ける。同じ強さで出すと
 *     あいまいな候補まで確定的に見えてしまい、投稿を躊躇させる。
 *   - 主導線は「元の投稿に返信する」。同じ話題は1箇所に集まる方が、あとから
 *     読む人にとって価値が高い。
 */
export function DuplicateWarning({
  duplicates,
  onReplyTo,
  onDismiss,
}: {
  duplicates: DuplicateCandidate[];
  /** 「元の投稿に返信」を選んだとき。投稿先をその投稿に切り替える。 */
  onReplyTo: (postId: number, authorName: string) => void;
  onDismiss: () => void;
}) {
  if (duplicates.length === 0) return null;

  const exact = duplicates.filter((d) => d.exact);
  const similar = duplicates.filter((d) => !d.exact);
  const hasExact = exact.length > 0;

  return (
    <Box
      data-cx="duplicate-warning"
      style={{
        border: `1px solid ${hasExact ? "var(--border-green)" : "var(--border-default)"}`,
        background: hasExact ? "var(--bg-tinted)" : "var(--bg-subtle)",
        borderRadius: 10,
        padding: "8px 10px",
        marginBottom: 8,
      }}
    >
      <Group justify="space-between" align="center" wrap="nowrap" mb={6}>
        <Text size="xs" fw={700} c={hasExact ? "green.8" : "dimmed"}>
          {hasExact ? "同じ内容の投稿がすでにあります" : "似た投稿があるかもしれません"}
        </Text>
        <UnstyledButton
          onClick={onDismiss}
          aria-label="警告を閉じる"
          data-cx="duplicate-dismiss"
          style={{ color: "var(--text-secondary)", lineHeight: 0, padding: 2 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </UnstyledButton>
      </Group>

      {duplicates.map((d) => (
        <Box
          key={d.postId}
          data-cx="duplicate-item"
          data-kind={d.kind}
          data-exact={d.exact ? "1" : "0"}
          style={{
            borderTop: "1px solid var(--border-default)",
            paddingTop: 6,
            marginTop: 6,
          }}
        >
          <Group gap={6} align="center" wrap="nowrap" mb={2}>
            <Text size="xs" fw={600}>
              {d.authorName}
            </Text>
            <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
              {relativeTime(d.createdAt)}
            </Text>
            {d.kind === "video" && (
              <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
                ・同じ動画
              </Text>
            )}
            {d.kind === "url" && (
              <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
                ・同じリンク
              </Text>
            )}
            {d.kind === "text" && (
              <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
                ・同じ本文
              </Text>
            )}
            {d.kind === "similar" && (
              <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
                ・似ている {Math.round(d.score * 100)}%
              </Text>
            )}
            {d.kind === "news" && (
              <Text size="xs" c="dimmed" style={{ opacity: 0.8 }}>
                ・同じニュース
              </Text>
            )}
          </Group>
          {/* AI が付けた理由（同じニュース判定のときだけ）。なぜ重複と
           *  言われたのかが分からないと、警告が納得できない。 */}
          {d.kind === "news" && d.reason && (
            <Text size="xs" c="dimmed" style={{ opacity: 0.75, marginBottom: 2 }}>
              {d.reason}
            </Text>
          )}
          <Text
            size="xs"
            c="dimmed"
            lineClamp={2}
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 4 }}
          >
            {d.text}
          </Text>
          <UnstyledButton
            onClick={() => onReplyTo(d.postId, d.authorName)}
            data-cx="duplicate-reply"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-green)",
              padding: "2px 0",
            }}
          >
            この投稿に返信する →
          </UnstyledButton>
        </Box>
      ))}

      <Text size="xs" c="dimmed" style={{ opacity: 0.75, marginTop: 8 }}>
        そのまま投稿することもできます。
      </Text>
    </Box>
  );
}

/** 「15分前」のような相対表記。1日以上前は日付にする。 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}日前`;
  const dt = new Date(iso);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}
