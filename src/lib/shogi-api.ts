/* ☗ 将棋の HTTP（Web の /api/shogi/* とアプリの /api/agent/shogi/* で共用）。
 * 認証は呼び出し側（Web はセッション、アプリは withAgent）。ここは道順・入力・応答の形だけ。
 *
 *   GET  games?status=open,offered,active,ended  一覧（終局は最近 20 局）
 *   POST games { mode, invitee_user_id?, rematch_of? }  募集（invitee なし）／指名／再戦（先後を入れ替える）
 *   GET  games/{id}                     全体（指し手・KIF の URL・my_color）
 *   POST games/{id}/accept | decline | cancel | resign
 *   POST games/{id}/move { usi, expected_ply, client_move_id }  手数が合わなければ 409 と最新の game
 *   POST games/{id}/watch               観戦中の合図（30 秒ごと）
 *   GET  games/{id}/kif                 棋譜（KIF、text/plain）
 * 応答: { apiVersion, game } など。エラーは { error, code, game? }（game は 409 のとき最新の状態）。 */
import {
  acceptGame,
  cancelGame,
  createGame,
  declineGame,
  gameKif,
  getGameDetail,
  listGames,
  playMove,
  resignGame,
  ShogiError,
  watchGame,
  type Actor,
  shogiSelfPlayFor,
} from "./shogi";
import type { ShogiStatus } from "./shogi-clock";
import { AGENT_API_VERSION } from "./agent-chat";

export type ShogiHttpOut =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; text: string; headers: Record<string, string> };

const STATUSES: ShogiStatus[] = ["open", "offered", "active", "ended"];

function parseId(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

export async function handleShogi(
  method: string,
  path: string[],
  actor: Actor,
  query: URLSearchParams,
  readBody: () => Promise<Record<string, unknown> | null>
): Promise<ShogiHttpOut> {
  try {
    const [root, idRaw, action, ...rest] = path;
    if (root !== "games" || rest.length > 0) return notFound();
    if (!idRaw) {
      if (method === "GET") {
        const want = (query.get("status") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is ShogiStatus => (STATUSES as string[]).includes(s));
        const games = await listGames(actor, want);
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, me: { user_id: actor.userId, self_play: shogiSelfPlayFor(actor.email) }, games } };
      }
      if (method === "POST") {
        const b = (await readBody()) ?? {};
        const game = await createGame(actor, { mode: b.mode, invitee_user_id: b.invitee_user_id, rematch_of: b.rematch_of });
        return { status: 201, body: { apiVersion: AGENT_API_VERSION, game } };
      }
      return notFound();
    }
    const id = parseId(idRaw);
    if (!id) return notFound();
    if (!action) {
      if (method !== "GET") return notFound();
      return { status: 200, body: { apiVersion: AGENT_API_VERSION, game: await getGameDetail(actor, id) } };
    }
    if (action === "kif" && method === "GET") {
      const k = await gameKif(actor, id);
      return {
        status: 200,
        text: k.text,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${k.filename}"`,
        },
      };
    }
    if (method !== "POST") return notFound();
    switch (action) {
      case "accept":
        return ok(await acceptGame(actor, id));
      case "decline":
        return ok(await declineGame(actor, id));
      case "cancel":
        return ok(await cancelGame(actor, id));
      case "resign":
        return ok(await resignGame(actor, id));
      case "move": {
        const b = (await readBody()) ?? {};
        const r = await playMove(actor, id, { usi: b.usi, expected_ply: b.expected_ply, client_move_id: b.client_move_id });
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, game: r.game, duplicate: r.duplicate } };
      }
      case "watch":
        return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...(await watchGame(actor, id)) } };
      default:
        return notFound();
    }
  } catch (e) {
    if (e instanceof ShogiError) {
      return { status: e.status, body: { error: e.message, code: e.code, ...(e.game ? { game: e.game } : {}) } };
    }
    console.error("[shogi api]", (e as Error)?.message);
    return { status: 500, body: { error: "サーバーエラー", code: "server_error" } };
  }
}

function ok(game: unknown): ShogiHttpOut {
  return { status: 200, body: { apiVersion: AGENT_API_VERSION, game } };
}

export function notFound(): ShogiHttpOut {
  return { status: 404, body: { error: "見つかりません", code: "not_found" } };
}
