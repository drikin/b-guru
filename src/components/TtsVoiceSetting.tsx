"use client";
/* 読み上げの声（⚙ の設定、文字サイズの下）。docs/offkai-spec.md「声の選び方」。
 * 自動 = この端末の日本語の声のうち、いちばん自然なもの。選んだ声はこのブラウザだけに覚える。 */
import { useEffect, useState } from "react";
import { Button, Group, NativeSelect, Text } from "@mantine/core";
import { autoVoiceName, japaneseVoices, onVoicesChanged, previewVoice, setTtsVoiceName, subscribeTts, ttsVoiceName } from "@/lib/offkai-tts";

const MARK = ["", "", "（拡張）", "（プレミアム）"];

/** 標準の声しか無いときの入れ方（この端末の OS に合わせて一行）。 */
function installHint(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const ios = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
  if (ios) return "「設定 › アクセシビリティ › 読み上げコンテンツ › 声 › 日本語」で、拡張・プレミアムの声を入れると自然になります。";
  if (/Macintosh/.test(ua)) return "「システム設定 › アクセシビリティ › 読み上げコンテンツ › システムの声 › 声を管理」で、日本語の拡張・プレミアムの声を入れると自然になります（入っていれば自動で使います）。";
  if (/Android/.test(ua)) return "端末の設定の「テキスト読み上げ」で、Google の日本語の音声データを入れると自然になります。";
  return "OS の読み上げの設定で、日本語の自然な声を足すと良くなります。";
}

export default function TtsVoiceSetting() {
  const [voices, setVoices] = useState<ReturnType<typeof japaneseVoices>>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [auto, setAuto] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      setVoices(japaneseVoices());
      setChosen(ttsVoiceName());
      setAuto(autoVoiceName());
    };
    read();
    const offV = onVoicesChanged(read);
    const offT = subscribeTts(read);
    return () => {
      offV();
      offT();
    };
  }, []);
  if (voices.length === 0) return null; // 読み上げが使えない・日本語の声が無いブラウザ
  const value = chosen && voices.some((v) => v.name === chosen) ? chosen : "";
  const best = Math.max(...voices.filter((v) => !v.novelty).map((v) => v.quality), 1);
  const label = (v: (typeof voices)[number]) => `${v.name.replace(/\s*\((Enhanced|Premium|拡張|プレミアム)\)\s*/i, " ").trim()}${MARK[v.quality] ?? ""}`;
  return (
    <div style={{ padding: "10px 12px", borderRadius: 8 }}>
      <Group gap="sm" wrap="nowrap" align="center" style={{ marginBottom: 8 }}>
        <span style={{ lineHeight: 1 }}>🗣</span>
        <span style={{ color: "var(--text-primary)", fontSize: "0.875rem", whiteSpace: "nowrap" }}>読み上げの声</span>
      </Group>
      <Group gap={6} wrap="nowrap">
        <NativeSelect
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          aria-label="読み上げの声"
          value={value}
          onChange={(e) => setTtsVoiceName(e.currentTarget.value || null)}
          data={[{ value: "", label: auto ? `自動（${label(voices.find((v) => v.name === auto) ?? { name: auto, quality: 1, novelty: false })}）` : "自動" }, ...voices.map((v) => ({ value: v.name, label: label(v) }))]}
        />
        <Button size="xs" variant="light" color="gray" onClick={() => previewVoice(value || null)}>
          ▶ 試す
        </Button>
      </Group>
      {best < 2 && (
        <Text size="xs" c="dimmed" mt={6}>
          {installHint()}
        </Text>
      )}
    </div>
  );
}
