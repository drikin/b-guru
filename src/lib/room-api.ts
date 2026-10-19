/* Request handling for the club room, shared by the web (/api/room, session) and
 * the apps (/api/agent/room, device token): the same rules, two DTO casings. */
import { roomMapDto } from "./room-map";
import { ROOM_REACTIONS, roomEnabledFor, roomEnter, roomMove, roomReact, roomSnapshot, roomToText, roomVoice, type RoomMember } from "./room";
import { toAgentRoomMemberDto } from "./agent-chat";
import { ensureUserId } from "./user";

type Out = { status: number; body: Record<string, unknown> };
type Casing = "web" | "agent";

const dto = (m: RoomMember, c: Casing) => (c === "agent" ? toAgentRoomMemberDto(m) : m);

/** The map, everyone in the house, and which of them is me. */
export async function roomGet(email: string, c: Casing): Promise<Out> {
  if (!roomEnabledFor(email)) return { status: 404, body: { error: "ルームはまだ使えません", code: "room_disabled" } };
  const me = await ensureUserId(email);
  const members = roomSnapshot().map((m) => dto(m, c));
  return {
    status: 200,
    body: c === "agent"
      ? { map: roomMapDto(), members, me, reactions: ROOM_REACTIONS }
      : { map: roomMapDto(), members, me, reactions: ROOM_REACTIONS },
  };
}

/** POST { action: "enter" | "text" | "move" | "voice" | "react", … } */
export async function roomPost(email: string, body: Record<string, unknown> | null, c: Casing): Promise<Out> {
  if (!roomEnabledFor(email)) return { status: 404, body: { error: "ルームはまだ使えません", code: "room_disabled" } };
  const a = body?.action;
  let r;
  switch (a) {
    case "enter":
      r = await roomEnter(email, body?.listening !== false);
      break;
    case "text":
      r = roomToText(email);
      break;
    case "move":
      r = roomMove(email, body?.x, body?.y);
      break;
    case "voice":
      r = roomVoice(email, { listening: body?.listening, mic: body?.mic });
      break;
    case "react": {
      const rr = roomReact(email, body?.emoji, body?.to);
      return rr.ok ? { status: 200, body: { ok: true } } : { status: rr.status, body: { error: rr.error } };
    }
    default:
      return { status: 400, body: { error: "action が不正です" } };
  }
  if (!r.ok) return { status: r.status, body: { error: r.error } };
  return { status: 200, body: { ok: true, member: dto(r.member, c), ...(r.from ? { from: r.from, to: r.to } : {}) } };
}
