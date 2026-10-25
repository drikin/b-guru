"use client";
/* 🍻 オフ会（Web）。☗・🎮・📺 の並びに「🍻」、開くとチャットの上にオフ会の面（docs/offkai-spec.md）。
 *
 *   OffkaiToggle  「🍻」（OFFKAI_ENABLED で出していない人には出さない。開催中は点）
 *   OffkaiPanel   開催中: 話している人・聞く／現地から話す（後勝ち）・終了・写真（時系列、📷 で上げる）
 *                 開催していない: 「オフ会を始める」とアーカイブ（開くとアルバム）
 * 状態は lib/offkai-client.ts（React の外）。 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Button, Group, Image, Loader, Modal, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import type { EventDto, PhotoDto } from "@/lib/offkai";
import {
  closeAlbum,
  deletePhoto,
  endOffkai,
  getServerSnapshot,
  getSnapshot,
  listen,
  loadMoreArchive,
  loadMorePhotos,
  loadOffkai,
  openAlbum,
  setOffkaiOpen,
  speak,
  startOffkai,
  stopAudio,
  stopSpeaking,
  subscribe,
  unlockOffkaiAudio,
  uploadPhotos,
  type OffkaiSnapshot,
} from "@/lib/offkai-client";

export function useOffkai(): OffkaiSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function OffkaiToggle() {
  const s = useOffkai();
  useEffect(() => {
    if (s.status === "unknown") void loadOffkai();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  const live = !!s.current;
  return (
    <Tooltip label={live ? `オフ会中${s.current?.title ? `: ${s.current.title}` : ""}` : "オフ会"} openDelay={400}>
      <ActionIcon
        size="md"
        variant={s.open ? "filled" : "light"}
        color={live && !s.open ? "orange" : "green"}
        aria-label="オフ会"
        title="オフ会"
        aria-pressed={s.open}
        data-cx="offkai-toggle"
        onClick={() => setOffkaiOpen(!s.open)}
        style={{ position: "relative", overflow: "visible" }}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
          🍻
        </span>
        {live && (
          <span
            aria-hidden
            style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, borderRadius: 4, background: "#e8590c", boxShadow: "0 0 0 2px var(--bg-surface)" }}
          />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

/** 面の高さの上限: チャット欄の高さの半分（残りでチャットが見える。☗・🎮 と同じ）。 */
function usePanelMax(ref: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [max, setMax] = useState(320);
  useEffect(() => {
    const col = ref.current?.parentElement;
    if (!on || !col || typeof ResizeObserver === "undefined") return;
    const update = () => setMax(Math.round(Math.max(200, Math.min(560, col.clientHeight * 0.5))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(col);
    return () => ro.disconnect();
  }, [ref, on]);
  return max;
}

const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function elapsed(iso: string, now: number): string {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

export function OffkaiPanel() {
  const s = useOffkai();
  const ref = useRef<HTMLDivElement>(null);
  const on = s.status === "enabled" && s.open;
  const max = usePanelMax(ref, on);
  const [viewing, setViewing] = useState<number | null>(null);
  if (!on) return null;
  const archived = s.album && s.album.event.ended_at ? s.album : null;
  return (
    <div
      ref={ref}
      data-cx="offkai-panel"
      style={{ maxHeight: max, overflowY: "auto", borderBottom: "1px solid var(--border-light)", padding: "8px 10px", flexShrink: 0 }}
    >
      {archived ? (
        <ArchivedAlbum event={archived.event} photos={archived.photos} more={archived.more != null} loading={!!archived.loading} onOpen={setViewing} />
      ) : s.current ? (
        <Live s={s} event={s.current} onOpen={setViewing} />
      ) : (
        <Lobby s={s} />
      )}
      {s.error && (
        <Text size="xs" c="red" mt={6}>
          {s.error.message}
        </Text>
      )}
      <PhotoViewer photos={s.album?.photos ?? []} index={viewing} onIndex={setViewing} />
    </div>
  );
}

function Lobby({ s }: { s: OffkaiSnapshot }) {
  const [title, setTitle] = useState("");
  return (
    <Stack gap={8}>
      <Group gap={6} wrap="nowrap" align="flex-end">
        <TextInput
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          label="🍻 オフ会を始める"
          placeholder="場所・ひとこと（例: 渋谷で飲んでます）"
          maxLength={40}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void startOffkai(title).then((ok) => ok && setTitle(""));
          }}
        />
        <Button size="xs" color="orange" loading={s.busy} onClick={() => void startOffkai(title).then((ok) => ok && setTitle(""))}>
          始める
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        始めると全員に 1 回だけお知らせします。現地の 1 台が声を流し、みんなで写真を上げられます（6 時間で自動で終わります）。
      </Text>
      {s.archive.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" fw={700} c="dimmed">
            これまでのオフ会
          </Text>
          {s.archive.map((e) => (
            <UnstyledButton
              key={e.id}
              onClick={() => void openAlbum(e)}
              style={{ display: "flex", gap: 8, alignItems: "center", padding: 4, borderRadius: 8 }}
            >
              {e.cover ? (
                <Image src={`${e.cover}?w=160`} w={40} h={40} radius="sm" fit="cover" alt="" />
              ) : (
                <span style={{ width: 40, height: 40, display: "grid", placeItems: "center", fontSize: 20 }}>🍻</span>
              )}
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>
                  {e.title || "オフ会"}
                </Text>
                <Text size="xs" c="dimmed">
                  {dateLabel(e.started_at)} · 写真 {e.photo_count} 枚 · {e.started_by.name ?? ""}
                </Text>
              </div>
            </UnstyledButton>
          ))}
          {s.archiveMore && (
            <Button size="compact-xs" variant="subtle" onClick={() => void loadMoreArchive()}>
              もっと見る
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function Live({ s, event, onOpen }: { s: OffkaiSnapshot; event: EventDto; onOpen: (i: number) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const me = s.myUserId;
  const iSpeak = !!me && event.speaker?.user_id === me;
  const [confirmEnd, setConfirmEnd] = useState(false);
  return (
    <Stack gap={8}>
      <Group justify="space-between" wrap="nowrap" gap={6}>
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={700} truncate>
            🍻 {event.title || "オフ会"}中
          </Text>
          <Text size="xs" c="dimmed">
            {elapsed(event.started_at, now)} · 🎧 {s.listeners}人が聞いています · {event.started_by.name ?? ""}さんが始めました
          </Text>
        </div>
        {event.can_end &&
          (confirmEnd ? (
            <Group gap={4} wrap="nowrap">
              <Button size="compact-xs" color="red" onClick={() => void endOffkai()}>
                終了する
              </Button>
              <Button size="compact-xs" variant="default" onClick={() => setConfirmEnd(false)}>
                やめる
              </Button>
            </Group>
          ) : (
            <Button size="compact-xs" variant="light" color="gray" onClick={() => setConfirmEnd(true)}>
              終了
            </Button>
          ))}
      </Group>
      <Text size="xs">
        {event.speaker && event.speaker.connected
          ? `🎙 ${event.speaker.name ?? "だれか"}さんが現地から話しています`
          : "🎙 いま現地から話している人はいません"}
      </Text>
      <Group gap={6}>
        {s.audio === "idle" ? (
          <Button size="xs" variant="light" onClick={() => void listen()}>
            🔊 聞く
          </Button>
        ) : (
          <Button size="xs" variant="light" color="gray" loading={s.audio === "connecting"} onClick={() => void stopAudio()}>
            🔇 聞くのをやめる
          </Button>
        )}
        {iSpeak && s.audio === "speaking" ? (
          <Button size="xs" color="red" variant="light" onClick={() => void stopSpeaking()}>
            話すのをやめる
          </Button>
        ) : (
          <Tooltip label="現地にいる人だけ。話せるのは 1 人で、押すと前の人から替わります" openDelay={300}>
            <Button size="xs" color="orange" variant="light" loading={s.speakBusy} onClick={() => void speak()}>
              🎙 現地から話す
            </Button>
          </Tooltip>
        )}
        {s.needsAudioUnlock && (
          <Button size="xs" variant="filled" onClick={() => void unlockOffkaiAudio()}>
            音を出す
          </Button>
        )}
      </Group>
      <PhotoUpload busy={s.uploading} />
      <PhotoGrid photos={s.album?.event.id === event.id ? s.album.photos : []} onOpen={onOpen} />
      {s.album?.more != null && (
        <Button size="compact-xs" variant="subtle" onClick={() => void loadMorePhotos()}>
          もっと見る
        </Button>
      )}
    </Stack>
  );
}

function PhotoUpload({ busy }: { busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  return (
    <Group gap={6} wrap="nowrap">
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length) void uploadPhotos(files, caption).then((ok) => ok && setCaption(""));
        }}
      />
      <TextInput
        size="xs"
        style={{ flex: 1, minWidth: 0 }}
        placeholder="写真にひとこと（任意）"
        maxLength={200}
        value={caption}
        onChange={(e) => setCaption(e.currentTarget.value)}
      />
      <Button size="xs" color="orange" loading={busy} onClick={() => input.current?.click()}>
        📷 写真
      </Button>
    </Group>
  );
}

function PhotoGrid({ photos, onOpen }: { photos: PhotoDto[]; onOpen: (i: number) => void }) {
  if (photos.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        まだ写真はありません。📷 から雰囲気を送ってください。
      </Text>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 4 }}>
      {photos.map((p, i) => (
        <UnstyledButton key={p.id} onClick={() => onOpen(i)} title={`${p.uploader.name ?? ""} ${dateLabel(p.created_at)}${p.caption ? ` — ${p.caption}` : ""}`}>
          <Image src={`${p.url}?w=320`} alt={p.caption || "オフ会の写真"} radius="sm" fit="cover" style={{ aspectRatio: "1 / 1", width: "100%" }} />
        </UnstyledButton>
      ))}
    </div>
  );
}

function ArchivedAlbum({ event, photos, more, loading, onOpen }: { event: EventDto; photos: PhotoDto[]; more: boolean; loading: boolean; onOpen: (i: number) => void }) {
  return (
    <Stack gap={8}>
      <Group gap={6} wrap="nowrap">
        <Button size="compact-xs" variant="subtle" onClick={() => closeAlbum()}>
          ← 戻る
        </Button>
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={700} truncate>
            🍻 {event.title || "オフ会"}
          </Text>
          <Text size="xs" c="dimmed">
            {dateLabel(event.started_at)}〜{event.ended_at ? dateLabel(event.ended_at) : ""} · 写真 {event.photo_count} 枚
          </Text>
        </div>
      </Group>
      {loading && photos.length === 0 ? (
        <Loader size="xs" />
      ) : photos.length === 0 && event.photo_count > 0 ? (
        <Button size="compact-xs" variant="subtle" onClick={() => void openAlbum(event)}>
          写真を読み込めませんでした。もう一度読む
        </Button>
      ) : (
        <PhotoGrid photos={photos} onOpen={onOpen} />
      )}
      {more && (
        <Button size="compact-xs" variant="subtle" onClick={() => void loadMorePhotos()}>
          もっと見る
        </Button>
      )}
    </Stack>
  );
}

function PhotoViewer({ photos, index, onIndex }: { photos: PhotoDto[]; index: number | null; onIndex: (i: number | null) => void }) {
  // 「消す」の確かめは、出した写真のときだけ（前後に動いたら消える）。
  const [confirmFor, setConfirmFor] = useState<number | null>(null);
  const p = index != null ? photos[index] : null;
  const confirmDel = !!p && confirmFor === p.id;
  const setConfirmDel = (on: boolean) => setConfirmFor(on && p ? p.id : null);
  useEffect(() => {
    if (index == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onIndex]);
  return (
    <Modal opened={!!p} onClose={() => onIndex(null)} size="xl" centered withCloseButton title={p ? `${p.uploader.name ?? ""} · ${dateLabel(p.created_at)}` : ""}>
      {p && (
        <Stack gap={8}>
          <Image src={p.url} alt={p.caption || "オフ会の写真"} fit="contain" mah="70vh" />
          {p.caption && <Text size="sm">{p.caption}</Text>}
          <Group justify="space-between">
            <Group gap={6}>
              <Button size="xs" variant="default" disabled={index === 0} onClick={() => onIndex((index ?? 0) - 1)}>
                ← 前
              </Button>
              <Button size="xs" variant="default" disabled={index === photos.length - 1} onClick={() => onIndex((index ?? 0) + 1)}>
                次 →
              </Button>
              <Text size="xs" c="dimmed">
                {(index ?? 0) + 1} / {photos.length}
              </Text>
            </Group>
            {p.mine &&
              (confirmDel ? (
                <Group gap={4}>
                  <Button
                    size="xs"
                    color="red"
                    onClick={() => {
                      onIndex(null);
                      void deletePhoto(p.id);
                    }}
                  >
                    消す
                  </Button>
                  <Button size="xs" variant="default" onClick={() => setConfirmDel(false)}>
                    やめる
                  </Button>
                </Group>
              ) : (
                <Button size="xs" variant="subtle" color="red" onClick={() => setConfirmDel(true)}>
                  この写真を消す
                </Button>
              ))}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
