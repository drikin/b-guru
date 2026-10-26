"use client";
/* 右サイドバー最上部: B-guru Chat for Mac（ベータ）のダウンロード案内（drikin 2026-10-15）。
 * - Mac のデスクトップでだけ出す（iPad は UA が Macintosh でもタッチ点で除外）
 * - 配布中の版があるときだけ出す（/api/download/mac/info）
 * - × で閉じたらこのブラウザでは出さない。新しい版が出たらまた出す */
import { useEffect, useState } from "react";
import { Anchor, CloseButton, Group, Paper, Stack, Text } from "@mantine/core";

type Info = { available: boolean; version?: string; size?: number; minimumSystemVersion?: string };

const DISMISS_KEY = "bguru-mac-app-card-dismissed"; // value = dismissed version

function isMacDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) === 0;
}

export default function MacAppCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (!isMacDesktop()) return;
    let alive = true;
    fetch("/api/download/mac/info", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Info | null) => {
        if (!alive || !d?.available) return;
        setInfo(d);
        let dismissed: string | null = null;
        try {
          dismissed = localStorage.getItem(DISMISS_KEY);
        } catch {
          /* storage blocked: just show it */
        }
        setHidden(dismissed === d.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (hidden || !info?.version) return null;
  const mb = info.size ? `${(info.size / 1024 / 1024).toFixed(1)} MB` : "";

  return (
    <Paper p="sm" radius="md" withBorder shadow="xs" style={{ borderColor: "var(--border-green)" }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap={6}>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text fw={700} size="sm">
            🐶 B-guru Chat for Mac
            <Text span size="xs" c="green.7" fw={600} ml={6}>
              ベータ
            </Text>
          </Text>
          <Text size="xs" c="dimmed">
            チャットをメニューバーから ⌃⌥B で。メンションは通知でお知らせ。
          </Text>
        </Stack>
        <CloseButton
          size="sm"
          aria-label="この案内を閉じる"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, info.version!);
            } catch {
              /* ignore */
            }
            setHidden(true);
          }}
        />
      </Group>
      <Anchor
        href="/api/download/mac"
        download
        mt={8}
        style={{
          display: "block",
          textAlign: "center",
          padding: "6px 10px",
          borderRadius: 8,
          background: "var(--mantine-color-green-filled)",
          color: "#fff",
          fontWeight: 600,
          fontSize: "0.8125rem",
          textDecoration: "none",
        }}
      >
        ダウンロード（{info.version}）
      </Anchor>
      <Text size="xs" c="dimmed" mt={6}>
        macOS {info.minimumSystemVersion ?? "14"} 以降・Apple シリコン / Intel{mb ? `・${mb}` : ""}
      </Text>
    </Paper>
  );
}
