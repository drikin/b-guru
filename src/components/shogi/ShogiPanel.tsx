"use client";
/* ☗ 将棋（Web）。チャットの上の「テキスト｜ルーム」の隣に「☗ 将棋」、開くと上に盤・下にチャット。
 *
 *   ShogiToggle     「☗ 将棋」のボタン（SHOGI_ENABLED で出していない人には何も出さない）
 *   ShogiPanel      ロビー（募集・指名・届いた申し込み・対局中・最近の結果）と盤（対局・観戦・再生）
 *   ShogiChatCard   チャットに流れる kind "shogi" の対局中カード（盤の小さな絵・観戦する）
 * 状態は lib/shogi-client.ts（React の外）。盤は lib/shogi-board/board.ts（アプリの WebView と同じ部品）。 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Badge, Button, CloseButton, Group, Select, Switch, Text, useComputedColorScheme } from "@mantine/core";
import ShogiBoard from "./ShogiBoard";
import {
  acceptShogiGame,
  cancelShogiGame,
  clearShogiNotice,
  clockNow,
  createShogiGame,
  declineShogiGame,
  fmtClock,
  getServerSnapshot,
  getSnapshot,
  loadShogi,
  myColorIn,
  openShogiGame,
  playShogiMove,
  resignShogiGame,
  selectGame,
  setShogiOpen,
  setShogiSettings,
  subscribe,
  watchShogiGame,
  type ShogiSnapshot,
} from "@/lib/shogi-client";
import { END_REASON_LABEL, INITIAL_SFEN, type EndReason, type Side } from "@/lib/shogi-rules";
import type { ShogiGameDto } from "@/lib/shogi-types";

function useShogi(): ShogiSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const MODE = { blitz: "⚡速い", slow: "🐢ゆっくり" } as const;

/** 「☗ 将棋」ボタン。row = 行に置く（ルームが無いとき、ボイスのバーの上）。 */
export function ShogiToggle({ row = false }: { row?: boolean }) {
  const s = useShogi();
  useEffect(() => {
    if (s.status === "unknown") void loadShogi();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  const mineActive = s.games.filter((g) => g.status === "active" && myColorIn(g, s.me)).length;
  const offers = s.games.filter((g) => g.status === "offered" && g.invitee?.user_id === s.me).length;
  const live = s.games.filter((g) => g.status === "active").length;
  const btn = (
    <Button
      size="compact-sm"
      variant={s.open ? "filled" : "light"}
      color="green"
      aria-pressed={s.open}
      onClick={() => setShogiOpen(!s.open)}
      title={live ? `対局中 ${live} 局` : "将棋を指す・観戦する"}
    >
      ☗ 将棋
      {offers + mineActive > 0 && (
        <Badge size="xs" color="red" ml={6} circle>
          {offers + mineActive}
        </Badge>
      )}
      {offers + mineActive === 0 && live > 0 && (
        <Text span size="xs" ml={4} style={{ opacity: 0.8 }}>
          {live}
        </Text>
      )}
    </Button>
  );
  if (!row) return btn;
  return (
    <div style={{ padding: "6px 10px 0", display: "flex", justifyContent: "flex-start" }}>{btn}</div>
  );
}

/** 将棋の画面はチャット欄の高さの約半分まで（ルームの地図と同じ考え方）。残りでチャットが見える。 */
function usePanelMax(ref: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [max, setMax] = useState(420);
  useEffect(() => {
    const col = ref.current?.parentElement;
    if (!on || !col || typeof ResizeObserver === "undefined") return;
    const update = () => setMax(Math.round(Math.max(260, Math.min(640, col.clientHeight * 0.52))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(col);
    return () => ro.disconnect();
  }, [ref, on]);
  return max;
}

/** 盤の周り（上の行・再生ボタン・余白）の分。盤はパネルの高さからこれを引いた高さに収める。 */
const BOARD_CHROME_PX = 96;

export function ShogiPanel() {
  const s = useShogi();
  const ref = useRef<HTMLDivElement>(null);
  const on = s.status === "enabled" && s.open;
  const max = usePanelMax(ref, on);
  if (!on) return null;
  return (
    <div
      ref={ref}
      data-cx="shogi-panel"
      style={{
        borderBottom: "1px solid var(--border-green-soft, var(--mantine-color-default-border))",
        padding: "6px 8px 8px",
        flex: "0 0 auto",
        maxHeight: max,
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      <Group gap={6} justify="space-between" wrap="nowrap" mb={4}>
        <GameTabs s={s} />
        <CloseButton size="sm" aria-label="将棋を閉じる" onClick={() => setShogiOpen(false)} />
      </Group>
      {s.notice && (
        <Group gap={4} wrap="nowrap" align="flex-start" mb={4}>
          <Text size="xs" c="orange" style={{ flex: 1 }} role="status">
            {s.notice}
          </Text>
          <CloseButton size="xs" aria-label="閉じる" onClick={clearShogiNotice} />
        </Group>
      )}
      {/* key: 別の対局に移ったら再生位置・反転・投了の確認を戻す */}
      {s.selectedId ? <GameView key={s.selectedId} s={s} boardMax={max - BOARD_CHROME_PX} /> : <Lobby s={s} />}
    </div>
  );
}

function GameTabs({ s }: { s: ShogiSnapshot }) {
  const mine = s.games.filter((g) => g.status === "active" && myColorIn(g, s.me));
  const watching = s.selectedId && !mine.some((g) => g.id === s.selectedId) ? s.games.find((g) => g.id === s.selectedId) : null;
  return (
    <Group gap={4} wrap="wrap" style={{ flex: 1 }}>
      <Button size="compact-xs" variant={s.selectedId ? "subtle" : "light"} color="green" onClick={() => selectGame(null)}>
        ロビー
      </Button>
      {mine.map((g) => {
        const my = myColorIn(g, s.me)!;
        const opp = my === "black" ? g.white : g.black;
        const myTurn = g.turn === my;
        return (
          <Button
            key={g.id}
            size="compact-xs"
            variant={s.selectedId === g.id ? "light" : "subtle"}
            color={myTurn ? "red" : "green"}
            onClick={() => selectGame(g.id)}
            title={myTurn ? "あなたの番" : "相手の番"}
          >
            {MODE[g.mode].slice(0, 2)} {opp?.name ?? "?"}
            {myTurn ? " ●" : ""}
          </Button>
        );
      })}
      {watching && (
        <Button size="compact-xs" variant="light" color="gray">
          {watching.status === "ended" ? "🎞" : "👀"} {watching.black?.name ?? "?"} vs {watching.white?.name ?? "?"}
        </Button>
      )}
    </Group>
  );
}

// ─────────────────────────── ロビー

type Member = { userId: string; name: string };

function Lobby({ s }: { s: ShogiSnapshot }) {
  const me = s.me;
  const offersToMe = s.games.filter((g) => g.status === "offered" && g.invitee?.user_id === me);
  const myPending = s.games.filter((g) => (g.status === "open" || g.status === "offered") && g.creator.user_id === me);
  const openOthers = s.games.filter((g) => g.status === "open" && g.creator.user_id !== me);
  const active = s.games
    .filter((g) => g.status === "active")
    .sort((a, b) => Number(!!myColorIn(b, me)) - Number(!!myColorIn(a, me)));
  const ended = s.games.filter((g) => g.status === "ended").slice(0, 10);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitee, setInvitee] = useState<string | null>(null);
  const [inviteMode, setInviteMode] = useState<"blitz" | "slow">("blitz");

  const loadMembers = () => {
    if (members) return;
    fetch("/api/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d) => setMembers(((d.members ?? []) as Member[]).filter((m) => m.userId !== me && m.name !== "ビーグル")))
      .catch(() => setMembers([]));
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Section title="対局を申し込む">
        <Group gap={6}>
          <Button size="compact-sm" color="green" disabled={s.busy} onClick={() => void createShogiGame("blitz")}>
            ⚡ 速い（10 分＋30 秒）で募集
          </Button>
          <Button size="compact-sm" color="green" variant="light" disabled={s.busy} onClick={() => void createShogiGame("slow")}>
            🐢 ゆっくりで募集
          </Button>
        </Group>
        <Group gap={6} mt={6} wrap="wrap" align="flex-end">
          <Select
            size="xs"
            placeholder="相手を指名"
            searchable
            clearable
            data={(members ?? []).map((m) => ({ value: m.userId, label: m.name }))}
            value={invitee}
            onChange={setInvitee}
            onDropdownOpen={loadMembers}
            onFocus={loadMembers}
            nothingFoundMessage={members ? "見つかりません" : "読み込み中…"}
            style={{ flex: "1 1 140px", minWidth: 140 }}
            aria-label="指名する相手"
          />
          <Select
            size="xs"
            data={[
              { value: "blitz", label: "⚡ 速い" },
              { value: "slow", label: "🐢 ゆっくり" },
            ]}
            value={inviteMode}
            onChange={(v) => setInviteMode(v === "slow" ? "slow" : "blitz")}
            allowDeselect={false}
            style={{ width: 110 }}
            aria-label="持ち時間"
          />
          <Button
            size="compact-sm"
            variant="light"
            color="green"
            disabled={!invitee || s.busy}
            onClick={() => {
              if (invitee) void createShogiGame(inviteMode, invitee).then(() => setInvitee(null));
            }}
          >
            指名する
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          先後は振り駒で決まります。募集は 15 分、指名は 24 時間で期限切れ。ゆっくりは 72 時間指さないと負けです。
        </Text>
      </Section>

      {offersToMe.length > 0 && (
        <Section title="届いた申し込み">
          {offersToMe.map((g) => (
            <Row key={g.id}>
              <Text size="sm" style={{ flex: 1 }}>
                {g.creator.name} さんから（{MODE[g.mode]}
                {g.rematch_of ? "・再戦" : ""}）
              </Text>
              <Button size="compact-xs" color="green" disabled={s.busy} onClick={() => void acceptShogiGame(g.id)}>
                受ける
              </Button>
              <Button size="compact-xs" variant="default" disabled={s.busy} onClick={() => void declineShogiGame(g.id)}>
                断る
              </Button>
            </Row>
          ))}
        </Section>
      )}

      {myPending.length > 0 && (
        <Section title="自分の申し込み">
          {myPending.map((g) => (
            <Row key={g.id}>
              <Text size="sm" style={{ flex: 1 }}>
                {g.status === "offered" ? `${g.invitee?.name ?? "?"} さんへ` : "募集中"}（{MODE[g.mode]}）
                <Text span size="xs" c="dimmed">
                  {" "}
                  〜{g.deadline_at ? new Date(g.deadline_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : ""}
                </Text>
              </Text>
              {s.selfPlay && g.status === "open" && (
                <Button size="compact-xs" color="green" disabled={s.busy} onClick={() => void acceptShogiGame(g.id)}>
                  自分と指す（テスト）
                </Button>
              )}
              <Button size="compact-xs" variant="default" disabled={s.busy} onClick={() => void cancelShogiGame(g.id)}>
                取り下げる
              </Button>
            </Row>
          ))}
        </Section>
      )}

      {openOthers.length > 0 && (
        <Section title="募集中">
          {openOthers.map((g) => (
            <Row key={g.id}>
              <Text size="sm" style={{ flex: 1 }}>
                {g.creator.name} さん（{MODE[g.mode]}）
              </Text>
              <Button size="compact-xs" color="green" disabled={s.busy} onClick={() => void acceptShogiGame(g.id)}>
                受ける
              </Button>
            </Row>
          ))}
        </Section>
      )}

      <Section title="対局中">
        {active.length === 0 ? (
          <Text size="xs" c="dimmed">
            いまはありません
          </Text>
        ) : (
          active.map((g) => (
            <Row key={g.id}>
              <Text size="sm" style={{ flex: 1 }}>
                ☗{g.black?.name} vs ☖{g.white?.name}
                <Text span size="xs" c="dimmed">
                  {" "}
                  {MODE[g.mode]}・{g.ply} 手{g.spectators ? `・👀${g.spectators}` : ""}
                </Text>
              </Text>
              <Button size="compact-xs" variant="light" color="green" onClick={() => selectGame(g.id)}>
                {myColorIn(g, me) ? "指す" : "観戦する"}
              </Button>
            </Row>
          ))
        )}
      </Section>

      {ended.length > 0 && (
        <Section title="最近の結果">
          {ended.map((g) => (
            <Row key={g.id}>
              <Text size="sm" style={{ flex: 1 }}>
                ☗{g.black?.name} vs ☖{g.white?.name}
                <Text span size="xs" c="dimmed">
                  {" "}
                  {resultText(g)}
                </Text>
              </Text>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => selectGame(g.id)}>
                再生
              </Button>
            </Row>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" fw={700} c="dimmed" mb={4}>
        {title}
      </Text>
      <div style={{ display: "grid", gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap" align="center">
      {children}
    </Group>
  );
}

function resultText(g: ShogiGameDto): string {
  const how = g.end_reason && g.end_reason in END_REASON_LABEL ? END_REASON_LABEL[g.end_reason as EndReason] : "";
  if (!g.result) return `中断・${g.ply} 手`;
  if (g.result === "draw") return `引き分け（${how}）・${g.ply} 手`;
  const w = g.result === "black" ? `☗${g.black?.name}` : `☖${g.white?.name}`;
  return `${w} の勝ち（${how}）・${g.ply} 手`;
}

// ─────────────────────────── 盤（対局・観戦・再生）

function GameView({ s, boardMax }: { s: ShogiSnapshot; boardMax?: number }) {
  const listed = s.games.find((g) => g.id === s.selectedId) ?? null;
  const d = s.detail && s.detail.id === s.selectedId ? s.detail : null;
  const g: ShogiGameDto | null = d ?? listed;
  const my = g ? myColorIn(g, s.me) : null;
  const scheme = useComputedColorScheme("light");
  const [flip, setFlip] = useState<Side | null>(null);
  const [replay, setReplay] = useState<number | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [, setTick] = useState(0);
  const gameId = g?.id ?? null;
  const active = g?.status === "active";

  // 時計を数える（速い将棋の対局中だけ）
  useEffect(() => {
    if (!active || g?.mode !== "blitz") return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [active, g?.mode]);

  // 観戦中の合図（30 秒ごと）。対局者は送らない。
  useEffect(() => {
    if (!gameId || !active || my) return;
    watchShogiGame(gameId);
    const t = setInterval(() => watchShogiGame(gameId), 30_000);
    return () => clearInterval(t);
  }, [gameId, active, my]);

  const moves = useMemo(() => d?.moves ?? [], [d?.moves]);
  if (!g) {
    return (
      <Text size="sm" c="dimmed">
        読み込み中…
      </Text>
    );
  }
  const ended = g.status === "ended";
  const viewPly = replay ?? (ended ? moves.length : null);
  const shownSfen = viewPly == null ? g.sfen : viewPly === 0 ? INITIAL_SFEN : moves[viewPly - 1]?.sfen ?? g.sfen;
  const shownLast = viewPly == null ? g.last_move : viewPly === 0 ? null : moves[viewPly - 1] ? { usi: moves[viewPly - 1].usi, label: moves[viewPly - 1].label } : null;
  const orientation: Side = flip ?? my ?? "black";
  const top: Side = orientation === "black" ? "white" : "black";
  const clocks = clockNow(g, s.skew);
  const label = (side: Side) => {
    const p = side === "black" ? g.black : g.white;
    const name = p?.name ?? "?";
    if (!clocks) return `${name}${g.status === "active" && g.turn === side ? "（手番）" : ""}`;
    const main = side === "black" ? clocks.black : clocks.white;
    const byo = g.turn === side && clocks.byoyomi != null ? ` 秒読み ${Math.ceil(clocks.byoyomi / 1000)}` : "";
    const t = g.status === "active" && g.ply < 2 ? "10:00" : fmtClock(main);
    return `${name} ${t}${byo}${g.status === "active" && g.turn === side ? " ●" : ""}`;
  };
  const canMove = active && !!my && g.turn === my && replay == null && !s.busy;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Group gap={6} justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          {MODE[g.mode]}・{g.ply} 手{g.spectators ? `・👀 ${g.spectators} 人が観戦中` : ""}
          {ended ? `・${resultText(g)}` : ""}
          {active && my ? (g.turn === my ? "・あなたの番" : "・相手の番") : ""}
        </Text>
      </Group>
      <ShogiBoard
        sfen={shownSfen}
        myColor={my}
        orientation={orientation}
        lastMove={shownLast}
        canMove={canMove}
        settings={s.settings}
        theme={scheme === "dark" ? "dark" : "light"}
        maxHeight={boardMax}
        topLabel={label(top)}
        bottomLabel={label(orientation)}
        onFlip={(o) => setFlip(o)}
        onMove={(usi) => void playShogiMove(g.id, usi, g.ply)}
      />
      {(ended || (d && moves.length > 0 && !my)) && (
        <Group gap={4} justify="center">
          <ActionIcon variant="default" aria-label="最初へ" onClick={() => setReplay(0)}>
            ⏮
          </ActionIcon>
          <ActionIcon variant="default" aria-label="1 手戻る" onClick={() => setReplay(Math.max(0, (viewPly ?? moves.length) - 1))}>
            ◀
          </ActionIcon>
          <Text size="xs" style={{ minWidth: 70, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {viewPly ?? moves.length} / {moves.length} 手
          </Text>
          <ActionIcon
            variant="default"
            aria-label="1 手進む"
            onClick={() => {
              const n = Math.min(moves.length, (viewPly ?? moves.length) + 1);
              setReplay(!ended && n >= moves.length ? null : n);
            }}
          >
            ▶
          </ActionIcon>
          <ActionIcon variant="default" aria-label="最後へ" onClick={() => setReplay(ended ? moves.length : null)}>
            ⏭
          </ActionIcon>
        </Group>
      )}
      <Group gap={6} wrap="wrap">
        {active && my && g.ply < 2 && (
          <Button size="compact-xs" variant="default" disabled={s.busy} onClick={() => void cancelShogiGame(g.id)}>
            取り消す（中断）
          </Button>
        )}
        {active && my && !confirmResign && (
          <Button size="compact-xs" variant="default" color="red" disabled={s.busy} onClick={() => setConfirmResign(true)}>
            投了
          </Button>
        )}
        {active && my && confirmResign && (
          <>
            <Text size="xs">投了しますか？</Text>
            <Button
              size="compact-xs"
              color="red"
              disabled={s.busy}
              onClick={() => {
                setConfirmResign(false);
                void resignShogiGame(g.id);
              }}
            >
              投了する
            </Button>
            <Button size="compact-xs" variant="default" onClick={() => setConfirmResign(false)}>
              やめる
            </Button>
          </>
        )}
        {ended && my && (
          <Button size="compact-xs" variant="light" color="green" disabled={s.busy} onClick={() => void createShogiGame(g.mode, null, g.id)}>
            再戦を申し込む（先後交代）
          </Button>
        )}
        {(ended || moves.length > 0) && g.black && (
          <Button size="compact-xs" variant="subtle" color="gray" component="a" href={`/api/shogi/games/${g.id}/kif`} download>
            KIF を書き出す
          </Button>
        )}
        {ended && g.result_post_id && (
          <Button size="compact-xs" variant="subtle" color="gray" component="a" href={`#/post/${g.result_post_id}`}>
            感想戦のスレッド
          </Button>
        )}
      </Group>
      {my && active && (
        <Group gap={12}>
          <Switch size="xs" label="指す前に確認" checked={s.settings.confirmMove} onChange={(e) => setShogiSettings({ confirmMove: e.currentTarget.checked })} />
          <Switch size="xs" label="駒の動きヒント" checked={s.settings.moveHints} onChange={(e) => setShogiSettings({ moveHints: e.currentTarget.checked })} />
        </Group>
      )}
    </div>
  );
}

// ─────────────────────────── チャットの対局中カード

/** SFEN の盤 → 9×9 の色の点（先手 = 濃い、後手 = 薄い）。駒の字は描かない（96px の小さな絵）。 */
export function MiniBoard({ sfen, size = 96 }: { sfen: string; size?: number }) {
  const cells: (0 | 1 | 2)[] = [];
  for (const row of (sfen.split(" ")[0] ?? "").split("/")) {
    for (const ch of row) {
      if (/[1-9]/.test(ch)) for (let i = 0; i < Number(ch); i++) cells.push(0);
      else if (ch === "+") continue;
      else cells.push(ch === ch.toUpperCase() ? 1 : 2);
    }
  }
  const c = size / 9;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="盤の様子" style={{ flex: "0 0 auto", borderRadius: 4 }}>
      <rect width={size} height={size} fill="#e9c98a" />
      {cells.slice(0, 81).map((v, i) =>
        v === 0 ? null : (
          <circle
            key={i}
            cx={(i % 9) * c + c / 2}
            cy={Math.floor(i / 9) * c + c / 2}
            r={c * 0.36}
            fill={v === 1 ? "#2b1d0e" : "#fff8e6"}
            stroke={v === 2 ? "#8a6a36" : "none"}
            strokeWidth={0.8}
          />
        )
      )}
    </svg>
  );
}

export function ShogiChatCard({ gameId, body }: { gameId: number; body: string }) {
  const s = useShogi();
  const g = s.games.find((x) => x.id === gameId) ?? null;
  const enabled = s.status === "enabled";
  return (
    <div
      data-cx="shogi-card"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "6px 8px",
        borderRadius: 10,
        border: "1px solid var(--border-green, var(--mantine-color-default-border))",
        background: "var(--bg-subtle)",
        alignSelf: "center",
        maxWidth: "94%",
      }}
    >
      {g && <MiniBoard sfen={g.sfen} />}
      <div style={{ minWidth: 0 }}>
        <Text size="xs" style={{ lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {g && g.status === "active" ? `☗${g.black?.name} vs ☖${g.white?.name}（${MODE[g.mode]}）${g.ply} 手目` : body}
        </Text>
        {g && g.status === "active" && g.last_move && (
          <Text size="xs" c="dimmed">
            最後の手 {g.last_move.label}
            {g.spectators ? `・👀${g.spectators}` : ""}
          </Text>
        )}
        {enabled && (
          <Button size="compact-xs" variant="light" color="green" mt={4} onClick={() => openShogiGame(gameId)}>
            {!g || g.status === "ended" ? "盤で見る" : myColorIn(g, s.me) ? "盤を開く" : "観戦する"}
          </Button>
        )}
      </div>
    </div>
  );
}
