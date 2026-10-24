/* GET /api/agent/capabilities — このサーバーが今サポートする機能と、呼び出し
 * トークンで使える操作。ネイティブアプリは起動時に読み、無い機能は隠し、
 * 知らない項目は無視する（再配布なしで Web の進化に追従するための契約）。 */
import { roomEnabledFor } from "@/lib/room";
import { jukeboxBrokenClient, jukeboxEnabledFor } from "@/lib/jukebox";
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentCapabilities } from "@/lib/agent-chat";
import { agentJson } from "../_lib";
import { voiceEnabledFor } from "@/lib/voice";
import { isAdmin } from "@/lib/admin";
import { shogiEnabledFor } from "@/lib/shogi";
import { commentaryEnabledFor } from "@/lib/shogi-commentary-store";
import { minigameEnabledFor } from "@/lib/minigame";
import { macAssistantEnabledFor } from "@/lib/feature-flag";
import { beagleOnDeviceEnabledFor } from "@/lib/beagle-ondevice";
import { beagleServerEnabledFor } from "@/lib/beagle-server";
import { dmCapability, dmEnabledFor } from "@/lib/dm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/capabilities", null, async (ctx) => ({
    status: 200,
    body: withDm(ctx.scopes, dmEnabledFor(ctx.email), agentCapabilities(ctx.scopes, { voice: voiceEnabledFor(ctx.email), voiceAdmin: isAdmin(ctx.email), room: roomEnabledFor(ctx.email), jukebox: jukeboxEnabledFor(ctx.email) && !jukeboxBrokenClient(req.headers.get("user-agent")), shogi: shogiEnabledFor(ctx.email), shogiCommentary: commentaryEnabledFor(ctx.email), minigame: minigameEnabledFor(ctx.email), appIssued: ctx.appIssued, macAssistant: macAssistantEnabledFor(ctx.email), beagleOnDevice: beagleOnDeviceEnabledFor(ctx.email), beagleServer: beagleServerEnabledFor(ctx.email) })),
    headers: {},
  }));
  return agentJson(out);
}

/** ✉️ 簡易 DM（DM_ENABLED）: features.dm と stream の "dm"・通知の "dm" を足す（lib/dm.ts の dmCapability）。
 *  対象でない人にも enabled:false を返す（アプリは隠す）。 */
function withDm(scopes: string[], enabled: boolean, caps: ReturnType<typeof agentCapabilities>) {
  return {
    ...caps,
    features: {
      ...caps.features,
      dm: dmCapability(enabled, scopes),
      stream: { ...caps.features.stream, events: [...caps.features.stream.events, ...(enabled ? ["dm"] : [])] },
      push: { ...caps.features.push, kinds: [...caps.features.push.kinds, ...(enabled ? ["dm"] : [])] },
    },
  };
}
