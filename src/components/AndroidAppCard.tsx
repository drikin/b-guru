"use client";
/* 左メニュー（スマホではドロワー）: B-guru Chat for Android（ベータ）のダウンロード案内（drikin 2026-10-16）。
 * - Android のブラウザでだけ出す
 * - 配布中の版があるときだけ出す（/api/download/android/info）
 * - × で閉じたらこのブラウザでは出さない。新しい版が出たらまた出す */
import { useEffect, useState } from "react";
import { Anchor, CloseButton, Group, Paper, Stack, Text } from "@mantine/core";

type Info = { available: boolean; version?: string; size?: number; cert_sha256?: string };

const DISMISS_KEY = "bguru-android-app-card-dismissed"; // value = dismissed version

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export default function AndroidAppCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (!isAndroid()) return;
    let alive = true;
    fetch("/api/download/android/info", { cache: "no-store" })
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
            🐶 B-guru Chat for Android
            <Text span size="xs" c="green.7" fw={600} ml={6}>
              ベータ
            </Text>
          </Text>
          <Text size="xs" c="dimmed">
            チャット専用アプリ。新着とメンションは通知でお知らせ。
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
        href="/api/download/android"
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
          fontSize: 13,
          textDecoration: "none",
        }}
      >
        ダウンロード（{info.version}）
      </Anchor>
      <Text size="xs" c="dimmed" mt={6}>
        Android 9 以降{mb ? `・${mb}` : ""}。インストール時に「提供元不明のアプリ」の許可が必要です。
      </Text>
    </Paper>
  );
}
