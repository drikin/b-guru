/* 📺 YouTube 共同鑑賞の HTTP（Web の /api/watch/* とアプリの /api/agent/watch/* で共用）。
 * 認証は呼び出し側（Web はセッション、アプリは withAgent）。ここは道順・入力・応答の形だけ。
 *
 *   GET  state                         今の状態 → { state }
 *   POST action { action, ... }        操作 → { state }
 *     load { url | video_id, position? }   いま流す（見ている全員が切り替わる）
 *     play { position? } / pause { position? } / seek { position }
 *     queue_add { url | video_id }   見たいものリストへ（何も流れていなければすぐ流す）
 *     queue_remove { id } / queue_play { id } / next / stop
 *     ended { video_id, version } / error { video_id, version, code? }   プレイヤーの報告（今の動画・版のときだけ次へ）
 * 応答: { apiVersion, ... }。エラーは { error, code }。 */
import { act, getState, WatchError, type Actor } from "./watch";
import { AGENT_API_VERSION } from "./agent-chat";
import { readJsonLimited } from "./minigame-api";

export type WatchHttpOut = { status: number; body: unknown };

export function notFound(): WatchHttpOut {
  return { status: 404, body: { error: "見つかりません", code: "not_found" } };
}

export { readJsonLimited };

export async function handleWatch(
  method: string,
  path: string[],
  actor: Actor,
  readBody: () => Promise<Record<string, unknown> | null | "too_large">,
): Promise<WatchHttpOut> {
  try {
    const [root, extra] = path;
    if (extra) return notFound();
    if (root === "state" && method === "GET") {
      return {
        status: 200,
        body: { apiVersion: AGENT_API_VERSION, state: await getState() },
      };
    }
    if (root === "action" && method === "POST") {
      const b = await readBody();
      if (b === "too_large")
        throw new WatchError(413, "too_large", "大きすぎます");
      return {
        status: 200,
        body: {
          apiVersion: AGENT_API_VERSION,
          state: await act(actor, b ?? {}),
        },
      };
    }
    return notFound();
  } catch (e) {
    if (e instanceof WatchError)
      return { status: e.status, body: { error: e.message, code: e.code } };
    console.error("watch:", (e as Error)?.message);
    return {
      status: 500,
      body: { error: "うまくいきませんでした", code: "internal" },
    };
  }
}
