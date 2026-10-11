"use client";
/* /settings/agent — AI エージェント API トークン管理（フェーズ1）。
 * 発行（スコープ選択・デバイス名・平文トークンは 1 回だけ表示）とデバイス一覧・失効。
 * 既存 UI の規約（Mantine・緑基調・日本語ラベル）に合わせる。 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import Link from "next/link";

interface DeviceRow {
  id: number;
  device_name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_ip: string | null;
  revoked: boolean;
}

const SCOPES: { key: string; label: string; hint: string }[] = [
  { key: "read", label: "read", hint: "投稿・通知・部活・チャット履歴の取得" },
  { key: "read_state", label: "read_state", hint: "既読・未読状態の読み書き（将来用）" },
  { key: "write", label: "write", hint: "投稿・リアクション（将来用・既定 OFF 推奨）" },
  { key: "chat", label: "chat", hint: "チャットの読み書き（将来用）" },
];

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("ja-JP");
}

export default function AgentSettingsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceName, setDeviceName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [issuing, setIssuing] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuedCopied, setIssuedCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      const d = await r.json();
      setAuthed(!!d?.authenticated);
      if (!d?.authenticated) {
        setLoading(false);
        return;
      }
      // デバイス一覧は settings ページ専用の軽い発行元 API ではなく、
      // フェーズ1では /api/agent/devices を経由しない: session 認証の
      // トークン一覧 API がないため、発行レスポンスと自己管理に絞る
      // → 実装をシンプルに保つため session 認証の list API を叩く。
      const lr = await fetch("/api/agent/settings-devices", { cache: "no-store" });
      if (lr.ok) {
        const ld = await lr.json();
        setDevices(ld.devices ?? []);
      }
    } catch {
      setError("読み込みに失敗しました");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const issue = async () => {
    setIssuing(true);
    setError(null);
    setIssuedToken(null);
    setIssuedCopied(false);
    try {
      const r = await fetch("/api/agent/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: deviceName, scopes }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "トークン発行に失敗しました");
      } else {
        setIssuedToken(d.token);
        setDeviceName("");
        loadDevices();
      }
    } catch {
      setError("通信エラー");
    }
    setIssuing(false);
  };

  const revoke = async (id: number) => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/agent/settings-devices/${id}`, { method: "DELETE" });
      if (r.ok) loadDevices();
      else setError("失効に失敗しました");
    } catch {
      setError("通信エラー");
    }
    setBusyId(null);
  };

  if (loading) {
    return (
      <Container size="sm" py="xl">
        <Loader size="sm" />
      </Container>
    );
  }

  if (authed === false) {
    return (
      <Container size="sm" py="xl">
        <Alert color="red" title="ログインが必要です">
          エージェントトークンの管理には <Link href="/">B-guru</Link> へのログインが必要です。
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="sm" py="xl">
      <Title order={2} mb="xs">
        AI エージェント API
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        エージェント（Claude / Hermes 等）が B-guru を読み取るための API トークンを発行します。
        トークンは発行時に一度だけ表示され、サーバーにはハッシュのみ保存されます。
        API 仕様は <Link href="/api/agent/openapi.json">/api/agent/openapi.json</Link> を参照してください。
      </Text>

      <Paper p="md" radius="md" withBorder mb="lg">
        <Title order={4} mb="sm">
          新しいトークンを発行
        </Title>
        <Stack gap="sm">
          <TextInput
            label="デバイス名"
            placeholder="例: 自宅のHermes"
            value={deviceName}
            maxLength={100}
            onChange={(e) => setDeviceName(e.currentTarget.value)}
          />
          <Checkbox.Group label="スコープ" value={scopes} onChange={setScopes}>
            <Stack gap={4} mt={4}>
              {SCOPES.map((s) => (
                <Checkbox key={s.key} value={s.key} label={`${s.label} — ${s.hint}`} />
              ))}
            </Stack>
          </Checkbox.Group>
          {error && (
            <Text size="sm" c="red">
              {error}
            </Text>
          )}
          <Group>
            <Button color="green" loading={issuing} disabled={!deviceName.trim()} onClick={issue}>
              発行する
            </Button>
          </Group>
          {issuedToken && (
            <Alert color="green" title="トークンを発行しました（この画面でしか表示されません）">
              <Text size="sm" style={{ wordBreak: "break-all" }} ff="monospace">
                {issuedToken}
              </Text>
              <Group mt="sm">
                <Button
                  size="xs"
                  variant="light"
                  color="green"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(issuedToken);
                      setIssuedCopied(true);
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  {issuedCopied ? "コピーしました" : "コピー"}
                </Button>
              </Group>
            </Alert>
          )}
        </Stack>
      </Paper>

      <Divider my="md" />
      <Title order={4} mb="sm">
        発行済みデバイス
      </Title>
      {devices.length === 0 ? (
        <Text size="sm" c="dimmed">
          発行されたトークンはありません。
        </Text>
      ) : (
        <Stack gap="sm">
          {devices.map((d) => (
            <Paper key={d.id} p="sm" radius="md" withBorder>
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    {d.device_name}
                    {d.revoked && (
                      <Text span size="xs" c="red" ml={6}>
                        失効済み
                      </Text>
                    )}
                  </Text>
                  <Text size="xs" c="dimmed">
                    スコープ: {d.scopes.join(", ")} ／ 最終使用: {fmt(d.last_used_at)} ／ 期限:{" "}
                    {fmt(d.expires_at)}
                  </Text>
                </div>
                {!d.revoked && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    loading={busyId === d.id}
                    onClick={() => revoke(d.id)}
                  >
                    失効
                  </Button>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Container>
  );
}
