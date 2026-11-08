"use client";
/* ✉️👥 DM の写真（Web、docs/dm-photos-spec.md）: 入力欄の 📷・貼り付け・ドロップ、選んだ写真の並び、吹き出しの写真と拡大。
 * 縮め方・枚数はチャットと同じ（lib/chat-photos.ts）。 */
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ActionIcon, CloseButton, Modal, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { CHAT_MAX_PHOTOS, imageFiles, photoSlots, prepareChatPhoto } from "@/lib/chat-photos";
import type { PickedPhoto } from "@/lib/dm-photos-client";

/** 選んだ写真（入力欄の下の並び）。送ったら clear で手放す（解放は送信側が後で行う）。 */
export function useDmPhotoPicker() {
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // ref は state と同時に更新する（描画を待たずに次の貼り付け・Enter が来ても、枚数と中身がずれない）。
  const ref = useRef<PickedPhoto[]>([]);
  const busyRef = useRef(0);
  const alive = useRef(true);
  const commit = useCallback((next: PickedPhoto[]) => {
    ref.current = next;
    setPhotos(next);
  }, []);
  // 画面を閉じたら、送らなかった写真のプレビューを解放する（準備中に閉じた分も add の後で解放）。
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ref.current.forEach((p) => URL.revokeObjectURL(p.preview));
      ref.current = [];
    };
  }, []);

  const add = useCallback(async (list: FileList | File[] | null | undefined) => {
    const files = imageFiles(list);
    if (files.length === 0) return false;
    setError(null);
    const take = photoSlots(ref.current.length + busyRef.current, files.length);
    if (take < files.length) setError(`写真は${CHAT_MAX_PHOTOS}枚までです`);
    if (take === 0) return true;
    busyRef.current += take;
    setBusy(busyRef.current);
    const ready: PickedPhoto[] = [];
    let failed = 0;
    for (const f of files.slice(0, take)) {
      try {
        const blob = await prepareChatPhoto(f);
        ready.push({ blob, preview: URL.createObjectURL(blob) });
      } catch {
        failed += 1;
      }
    }
    busyRef.current -= take;
    if (!alive.current) {
      ready.forEach((p) => URL.revokeObjectURL(p.preview));
      return true;
    }
    setBusy(busyRef.current);
    if (failed) setError("読み込めない画像がありました");
    if (ready.length) commit([...ref.current, ...ready]);
    return true;
  }, [commit]);

  const remove = useCallback(
    (preview: string) => {
      URL.revokeObjectURL(preview);
      commit(ref.current.filter((p) => p.preview !== preview));
      setError(null);
    },
    [commit]
  );

  /** 送った: 写真は送信側（dm-photos-client）が持つので、ここでは解放せずに空にする。 */
  const take = useCallback((): PickedPhoto[] => {
    const out = ref.current;
    commit([]);
    setError(null);
    return out;
  }, [commit]);

  /** 送れなかった写真を戻す（入力欄に写真が無いときだけ。あれば戻す分は解放する）。 */
  const put = useCallback(
    (back: PickedPhoto[]) => {
      if (back.length === 0) return;
      if (ref.current.length === 0 && busyRef.current === 0) commit(back.slice(0, CHAT_MAX_PHOTOS));
      else back.forEach((p) => URL.revokeObjectURL(p.preview));
    },
    [commit]
  );

  /** 入力欄の貼り付け: 画像があれば添付（テキストの貼り付けはそのまま）。 */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = imageFiles(Array.from(e.clipboardData?.files ?? []));
      if (files.length === 0) return;
      e.preventDefault();
      void add(files);
    },
    [add]
  );

  return { photos, busy, error, add, remove, take, put, onPaste };
}

export type DmPhotoPicker = ReturnType<typeof useDmPhotoPicker>;

/** 画面全体（会話）へのドロップで添付する。 */
export function useDmPhotoDrop(picker: DmPhotoPicker, enabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    over,
    handlers: enabled
      ? {
          onDragEnter: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current += 1;
            setOver(true);
          },
          onDragOver: (e: DragEvent) => {
            if (hasFiles(e)) e.preventDefault();
          },
          onDragLeave: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          },
          onDrop: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            void picker.add(Array.from(e.dataTransfer.files));
          },
        }
      : {},
  };
}

/** 📷 ボタン（ファイルを選ぶ）。 */
export function DmPhotoButton({ picker, disabled }: { picker: DmPhotoPicker; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const full = picker.photos.length + picker.busy >= CHAT_MAX_PHOTOS;
  return (
    <>
      <Tooltip label={full ? `写真は${CHAT_MAX_PHOTOS}枚までです` : "写真を付ける（貼り付け・ドロップでも）"} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="写真を付ける"
          disabled={disabled || full}
          onClick={() => input.current?.click()}
          data-cx="dm-photo"
        >
          📷
        </ActionIcon>
      </Tooltip>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void picker.add(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </>
  );
}

/** 入力欄の上に出す、選んだ写真の並び（× で外す）。 */
export function DmPhotoTray({ picker }: { picker: DmPhotoPicker }) {
  if (picker.photos.length === 0 && picker.busy === 0 && !picker.error) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", paddingBottom: 6 }}>
      {picker.photos.map((p) => (
        <div key={p.preview} style={{ position: "relative", width: 56, height: 56, borderRadius: 8, overflow: "hidden", background: "var(--bg-subtle)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.preview} alt="付ける写真" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <CloseButton
            size="xs"
            radius="xl"
            variant="filled"
            aria-label="写真を外す"
            onClick={() => picker.remove(p.preview)}
            style={{ position: "absolute", top: 2, right: 2 }}
          />
        </div>
      ))}
      {picker.busy > 0 && (
        <Text size="xs" c="dimmed">
          写真を準備中…
        </Text>
      )}
      {picker.error && (
        <Text size="xs" c="red">
          {picker.error}
        </Text>
      )}
    </div>
  );
}

/** ドロップ中の重ね表示。 */
export function DmDropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--mantine-color-body) 80%, transparent)",
        border: "2px dashed var(--mantine-color-green-6)",
        borderRadius: 8,
        pointerEvents: "none",
      }}
    >
      <Text fw={600} c="green">
        ここにドロップして写真を付ける
      </Text>
    </div>
  );
}

/** 吹き出しの写真: 1 枚は幅 220px まで、2〜4 枚は小さな正方形の格子。押すと拡大。 */
export function DmImageGrid({ urls }: { urls: string[] | undefined }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!urls || urls.length === 0) return null;
  const single = urls.length === 1;
  return (
    <>
      {/* 吹き出しは中身の幅に縮むので、1 枚のときも幅を決めておく（100% だと幅 0 になる）。 */}
      <div style={{ display: "grid", gridTemplateColumns: single ? "220px" : "repeat(2, 96px)", gap: 4, maxWidth: "100%" }}>
        {urls.map((src, i) => (
          <UnstyledButton
            key={src}
            onClick={() => setOpen(i)}
            aria-label="写真を拡大"
            style={{ display: "block", borderRadius: 10, overflow: "hidden", lineHeight: 0, background: "var(--bg-subtle)" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt="写真"
              loading="lazy"
              decoding="async"
              style={
                single
                  ? { display: "block", width: 220, maxWidth: "100%", height: "auto", maxHeight: 300, objectFit: "cover" }
                  : { display: "block", width: 96, height: 96, objectFit: "cover" }
              }
            />
          </UnstyledButton>
        ))}
      </div>
      <Modal opened={open != null} onClose={() => setOpen(null)} size="auto" centered withCloseButton title={urls.length > 1 && open != null ? `${open + 1} / ${urls.length}` : "写真"}>
        {open != null && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={urls[open]} alt="写真" style={{ maxWidth: "min(92vw, 1200px)", maxHeight: "78vh", objectFit: "contain", display: "block" }} />
            {urls.length > 1 && (
              <div style={{ display: "flex", gap: 8 }}>
                <ActionIcon variant="default" aria-label="前の写真" disabled={open === 0} onClick={() => setOpen((i) => (i == null ? i : i - 1))}>
                  ‹
                </ActionIcon>
                <ActionIcon variant="default" aria-label="次の写真" disabled={open === urls.length - 1} onClick={() => setOpen((i) => (i == null ? i : i + 1))}>
                  ›
                </ActionIcon>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
