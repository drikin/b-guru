"use client";
/* ✉️👥 DM の写真（Web、docs/dm-photos-spec.md）。送る発言ごと（client_id）に縮めた写真を持ち、
 * 送るときに /api/dm/upload へ上げる。上げた URL は覚えておき、再送で上げ直さない。
 * 楽観的な吹き出しはプレビュー（blob: URL）を出し、サーバの発言に置き換わったら少し後に解放する。 */
import { uploadChatPhotos } from "./chat-photos";

export type PickedPhoto = { blob: Blob; preview: string };
type Job = { blobs: Blob[]; previews: string[]; urls?: string[] };

const jobs = new Map<string, Job>();

export function setDmPhotoJob(clientId: string, photos: PickedPhoto[]): string[] {
  if (photos.length === 0) return [];
  const job: Job = { blobs: photos.map((p) => p.blob), previews: photos.map((p) => p.preview) };
  jobs.set(clientId, job);
  return job.previews;
}

export function hasDmPhotoJob(clientId: string | undefined): boolean {
  return !!clientId && jobs.has(clientId);
}

/** 写真を上げて URL を返す（写真が無ければ undefined）。失敗は Error（status つき）を投げる。 */
export async function uploadDmPhotoJob(clientId: string | undefined): Promise<string[] | undefined> {
  const job = clientId ? jobs.get(clientId) : undefined;
  if (!job) return undefined;
  if (job.urls) return job.urls;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    job.urls = await uploadChatPhotos(job.blobs, ac.signal, "/api/dm/upload");
    return job.urls;
  } finally {
    clearTimeout(timer);
  }
}

/** 送れない写真を入力欄へ戻す: 写真を手放さずに取り出す（プレビューはそのまま入力欄で使う）。 */
export function takeDmPhotoJob(clientId: string | undefined): PickedPhoto[] {
  const job = clientId ? jobs.get(clientId) : undefined;
  if (!job || !clientId) return [];
  jobs.delete(clientId);
  return job.blobs.map((blob, i) => ({ blob, preview: job.previews[i] }));
}

/** 送れた・取り消した: 写真を手放す（吹き出しがサーバの URL に替わるまで少し待ってから解放）。 */
export function dropDmPhotoJob(clientId: string | undefined): void {
  const job = clientId ? jobs.get(clientId) : undefined;
  if (!job || !clientId) return;
  jobs.delete(clientId);
  setTimeout(() => job.previews.forEach((u) => URL.revokeObjectURL(u)), 5_000);
}

/** 会話を離れる（画面を閉じる・別の会話へ）: まだ送れていない吹き出しの写真を手放す（Blob を残さない）。 */
export function dropUnsentPhotoJobs(messages: { id: number; client_id?: string }[]): void {
  for (const m of messages) if (m.id < 0) dropDmPhotoJob(m.client_id);
}

/** 写真を上げられなかったときの文（中断は英語のままにしない）。 */
export function photoUploadError(e: unknown): string {
  const err = e as { name?: string; message?: string; status?: number };
  if (err?.name === "AbortError") return "写真の送信に時間がかかりすぎました。もう一度送ってください";
  if (err?.status === 401) return "ログインが切れました。再ログインしてください";
  return err?.message || "写真を送れませんでした";
}

/** 再送しても通らない失敗（大きすぎ・形式・ログイン切れ・DM が使えない）。 */
export function permanentUploadFailure(e: unknown): boolean {
  const st = (e as { status?: number })?.status ?? 0;
  return st >= 400 && st < 500 && st !== 408 && st !== 429;
}

/** 一覧・通知の短い文: 本文が空で写真があれば「📷 写真」。 */
export function dmPreviewText(m: { body: string; images?: string[] | null } | null | undefined): string {
  if (!m) return "";
  if (!m.body && (m.images?.length ?? 0) > 0) return "📷 写真";
  return m.body;
}
