/* 部活の表示・非表示をアプリから（/api/agent/clubs/visibility）。Web の /api/clubs/visibility と同じ決まり。
 * 2026-10-28 ドリキン「ネイティブアプリで部活ごとの表示非表示がコントロールできない」。 */
import type { AgentContext } from "./agent-auth";
import { CLUB_UNSET } from "./club-catalog";
import { isActiveClubKey, listClubs } from "./club-store";
import { getHiddenClubs, setAllClubsHidden, setClubHidden } from "./club-visibility";

// DB の active な部活（admin が後から追加した部活も含む）か「未設定」。表示に戻す側は、削除済み
// 部活の行も消せるよう検証しない。
export async function isValidClubKey(key: string, hidden: boolean): Promise<boolean> {
  return (
    key === CLUB_UNSET ||
    (/^[a-z0-9_-]{1,40}$/.test(key) && (!hidden || (await isActiveClubKey(key))))
  );
}

type Out = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

/** GET → { apiVersion, hidden: [key...] }（"__unset__" は「未設定」） */
export async function getVisibilityApi(ctx: AgentContext): Promise<Out> {
  return { status: 200, body: { apiVersion: 1, hidden: Array.from(await getHiddenClubs(ctx.email)).sort() }, headers: {} };
}

/** PUT { club, hidden } → { apiVersion, club, hidden }
 *  PUT { all: true, hidden } → { apiVersion, hidden: [key...] }（全部 OFF / 全部 ON。2026-11-08） */
export async function setVisibilityApi(ctx: AgentContext, body: Record<string, unknown>): Promise<Out> {
  if (body.all === true) {
    const hide = body.hidden === true;
    const keys = hide ? [...(await listClubs()).map((c) => c.key), CLUB_UNSET] : [];
    await setAllClubsHidden(ctx.email, keys, hide);
    return { status: 200, body: { apiVersion: 1, hidden: Array.from(await getHiddenClubs(ctx.email)).sort() }, headers: {} };
  }
  const club = typeof body.club === "string" ? body.club.trim() : "";
  const hidden = body.hidden === true;
  if (!club || !(await isValidClubKey(club, hidden))) {
    return { status: 400, body: { error: "不正な部活キーです", code: "invalid_request" }, headers: {} };
  }
  await setClubHidden(ctx.email, club, hidden);
  return { status: 200, body: { apiVersion: 1, club, hidden }, headers: {} };
}
