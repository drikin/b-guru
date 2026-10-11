"use client";
/* /connect — Claude（等の MCP クライアント）への接続案内ページ（フェーズ2）。
 * コネクタ URL（https://bsm.backspace.fm/mcp）の表示・コピー、発行済み
 * デバイスの選択表示、未発行なら /settings/agent へ誘導。
 * 既存 UI 規約（Mantine・ダークテーマ・日本語ラベル）に合わせる。 */
import { useCallback, useEffect, useState, startTransition } from "react";
import {
  Alert,
  Button,
  Code,
  Container,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import Link from "next/link";

const MCP_URL = "https://bsm.backspace.fm/mcp";

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

export default function ConnectPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      const d = await r.json();
      const isAuthed = !!d?.authenticated;
      let devs: DeviceRow[] = [];
      if (isAuthed) {
        const lr = await fetch("/api/agent/settings-devices", { cache: "no-store" });
        if (lr.ok) {
          const ld = await lr.json();
          devs = ld.devices ?? [];
        }
      }
      // setState は同一バッチで 1 回だけ呼ぶ（cascading render 回避）。
      startTransition(() => {
        setAuthed(isAuthed);
        setDevices(devs);
        setLoading(false);
      });
    } catch {
      startTransition(() => {
        setAuthed(null);
        setLoading(false);
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
          Claude との接続には <Link href="/">B-guru</Link> へのログインが必要です。
        </Alert>
      </Container>
    );
  }

  const active = devices.filter((d) => !d.revoked);
  const writeScopes = ["write", "read_state", "chat"];

  return (
    <Container size="sm" py="xl">
      <Title order={2} mb="xs">
        Claude に接続
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        B-guru を Claude のコネクタ（リモート MCP サーバー）として追加できます。
        タイムラインの読み取り、投稿、リアクションなどを Claude から行えるようになります。
      </Text>

      <Paper p="md" radius="md" withBorder mb="lg">
        <Title order={4} mb="sm">
          1. コネクタ URL をコピー
        </Title>
        <Code block style={{ wordBreak: "break-all" }}>
          {MCP_URL}
        </Code>
        <Group mt="sm">
          <CopyButton value={MCP_URL}>
            {({ copied: c, copy }) => (
              <Button
                size="xs"
                variant="light"
                color="green"
                onClick={copy}
                data-testid="copy-mcp-url"
              >
                {c ? "コピーしました" : "コピー"}
              </Button>
            )}
          </CopyButton>
          <Button size="xs" variant="light" color="green" component="a" href={MCP_URL}>
            URL を開く
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          Claude（claude.ai の「設定 → コネクタ → カスタムコネクタを追加」または
          Claude Desktop）にこの URL を登録してください。接続時に Bearer
          トークンの入力を求められます。
        </Text>
      </Paper>

      {active.length === 0 ? (
        <Alert color="yellow" title="エージェントトークンがありません">
          まず <Link href="/settings/agent">/settings/agent</Link>{" "}
          でトークンを発行してください。発行時に表示されるトークン（bga_ で始まる文字列）を、
          Claude の接続設定の認証（Authorization ヘッダ）に貼り付けてください。
        </Alert>
      ) : (
        <>
          <Title order={4} mb="sm">
            2. トークン（発行済みデバイス）
          </Title>
          <Stack gap="sm" mb="lg">
            {active.map((d) => (
              <Paper key={d.id} p="sm" radius="md" withBorder>
                <Text size="sm" fw={600}>
                  {d.device_name}
                </Text>
                <Text size="xs" c="dimmed">
                  スコープ: {d.scopes.join(", ")}
                  {writeScopes.some((s) => d.scopes.includes(s)) &&
                    " ／ 書き込み可能なスコープが含まれています"}
                </Text>
              </Paper>
            ))}
          </Stack>
          <Alert color="green" title="Claude への追加手順">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>上のボタンでコネクタ URL をコピーする</li>
              <li>claude.ai（設定 → コネクタ）または Claude Desktop に貼り付けて追加する</li>
              <li>認証には /settings/agent で発行したトークンを Bearer として入力する</li>
            </ol>
          </Alert>
          <Text size="xs" c="dimmed" mt="sm">
            デバイスの追加・失効は <Link href="/settings/agent">/settings/agent</Link> で行えます。
          </Text>
        </>
      )}
    </Container>
  );
}
