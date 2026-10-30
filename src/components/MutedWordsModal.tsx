"use client";
/* NG ワード（本人の設定。サーバに保存してアプリと共通。drikin 2026-10-29）。
 * 言葉を含むほかの人の投稿・返信はタイムラインに出ず、その知らせも来ない（自分の投稿は出る）。 */
import { useEffect, useState } from "react";
import { ActionIcon, Badge, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";

export default function MutedWordsModal({
  opened,
  onClose,
  onChanged,
}: {
  opened: boolean;
  onClose: () => void;
  /** Called after a successful save (the timeline reloads). */
  onChanged: () => void;
}) {
  const [words, setWords] = useState<string[]>([]);
  const [max, setMax] = useState(50);
  const [maxLength, setMaxLength] = useState(40);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!opened) return;
    setError("");
    setDraft("");
    setLoaded(false);
    fetch("/api/muted-words", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || "読み込めませんでした");
        setWords(d.words ?? []);
        if (d.max) setMax(d.max);
        if (d.maxLength) setMaxLength(d.maxLength);
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [opened]);

  const save = async (next: string[]) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/muted-words", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || "保存できませんでした");
      setWords(d.words ?? next);
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const w = draft.trim();
    if (!w) return;
    if (await save([...words, w])) setDraft("");
  };

  return (
    <Modal opened={opened} onClose={onClose} title="NG ワード" centered>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          ここに入れた言葉を含む投稿・返信はタイムラインと検索に出ず、知らせも来ません（自分の投稿は出ます）。大文字小文字・全角半角は区別しません。アプリと同じ設定です。
        </Text>
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="言葉を入力"
            aria-label="NG ワード"
            value={draft}
            maxLength={maxLength}
            disabled={!loaded || busy || words.length >= max}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void add();
              }
            }}
          />
          <Button onClick={() => void add()} disabled={!loaded || busy || !draft.trim() || words.length >= max}>
            追加
          </Button>
        </Group>
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        {loaded && words.length === 0 && (
          <Text size="sm" c="dimmed">
            まだありません
          </Text>
        )}
        <Group gap={6}>
          {words.map((w) => (
            <Badge
              key={w}
              variant="light"
              color="gray"
              size="lg"
              style={{ textTransform: "none" }}
              rightSection={
                <ActionIcon
                  size="xs"
                  variant="transparent"
                  color="gray"
                  aria-label={`「${w}」を消す`}
                  disabled={busy}
                  onClick={() => void save(words.filter((x) => x !== w))}
                >
                  ×
                </ActionIcon>
              }
            >
              {w}
            </Badge>
          ))}
        </Group>
        {loaded && (
          <Text size="xs" c="dimmed">
            {words.length} / {max} 個
          </Text>
        )}
      </Stack>
    </Modal>
  );
}
