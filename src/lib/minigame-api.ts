/* 🎮 締め切りダッシュの HTTP（Web の /api/minigame/* とアプリの /api/agent/minigame/* で共用）。
 * 認証は呼び出し側（Web はセッション、アプリは withAgent）。ここは道順・入力・応答の形だけ。
 *
 *   GET  me                                  情報（今日の種・自分のベスト・今日の 1 位・今日遊んだ回数）
 *   POST plays { mode, character }           1 回の発行 → { play }（1 回限り・30 分で期限切れ）
 *   POST plays/{id}/finish { inputs, engine_version, score?, ticks? }  検算して記録 → { result }
 *   GET  leaderboard?period=today|week|all&mode=daily|free   順位表（上位 50 と自分）
 *   管理者だけ: GET admin/plays?user_id=&limit=、POST admin/plays/{id}/reject、POST admin/users/{user_id}/clear
 * 応答: { apiVersion, ... }。エラーは { error, code }。 */
import {
  adminClearUser,
  adminListPlays,
  adminRejectPlay,
  finishPlay,
  getInfo,
  getLeaderboard,
  issuePlay,
  MinigameError,
  type Actor,
} from "./minigame";
import { isAdmin } from "./admin";
import { AGENT_API_VERSION } from "./agent-chat";

export type MinigameHttpOut = { status: number; body: unknown };

/** 本文の上限（操作の記録 64KB ＋ ほかの項目）。 */
export const MAX_BODY_BYTES = 80 * 1024;

function parseId(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

export function notFound(): MinigameHttpOut {
  return { status: 404, body: { error: "見つかりません", code: "not_found" } };
}

/** 本文を読む（大きすぎれば null ではなく "too_large"）。 */
export async function readJsonLimited(req: Request): Promise<Record<string, unknown> | null | "too_large"> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return "too_large";
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return "too_large";
  try {
    const b = JSON.parse(text);
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleMinigame(
  method: string,
  path: string[],
  actor: Actor,
  query: URLSearchParams,
  readBody: () => Promise<Record<string, unknown> | null | "too_large">
): Promise<MinigameHttpOut> {
  try {
    const [root, a, b, ...rest] = path;
    const body = async () => {
      const x = await readBody();
      if (x === "too_large") throw new MinigameError(413, "too_large", "記録が大きすぎます");
      return x ?? {};
    };
    if (root === "me" && !a && method === "GET") {
      return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...(await getInfo(actor)) } };
    }
    if (root === "leaderboard" && !a && method === "GET") {
      const lb = await getLeaderboard(actor, query.get("period"), query.get("mode"));
      return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...lb } };
    }
    if (root === "plays" && method === "POST") {
      if (!a) return { status: 201, body: { apiVersion: AGENT_API_VERSION, play: await issuePlay(actor, await body()) } };
      const id = parseId(a);
      if (id && b === "finish" && rest.length === 0) {
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, result: await finishPlay(actor, id, await body()) } };
      }
      return notFound();
    }
    if (root === "admin") {
      if (!isAdmin(actor.email)) return { status: 403, body: { error: "管理者だけが使えます", code: "forbidden" } };
      if (a === "plays" && !b && method === "GET") {
        const plays = await adminListPlays(query.get("user_id") || null, Number(query.get("limit") ?? 50));
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, plays } };
      }
      if (a === "plays" && method === "POST" && rest[0] === "reject" && rest.length === 1) {
        const id = parseId(b);
        if (!id) return notFound();
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...(await adminRejectPlay(id)) } };
      }
      if (a === "users" && b && method === "POST" && rest[0] === "clear" && rest.length === 1) {
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...(await adminClearUser(b)) } };
      }
      return notFound();
    }
    return notFound();
  } catch (e) {
    if (e instanceof MinigameError) return { status: e.status, body: { error: e.message, code: e.code } };
    console.error("[minigame api]", (e as Error)?.message);
    return { status: 500, body: { error: "サーバーエラー", code: "server_error" } };
  }
}
