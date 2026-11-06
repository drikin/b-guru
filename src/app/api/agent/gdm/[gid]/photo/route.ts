/* /api/agent/gdm/:gid/photo — 👥 グループの写真（アプリの鍵、スコープ chat）。
 *   POST   : 設定・取り替え（multipart の photo。端末で縮めてから送る）
 *   DELETE : 外す
 * 写真を読むのは /api/gdm/:gid/photo（DTO の photo。鍵の Bearer で読める）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmRemovePhotoApi, gdmSetPhotoApi } from "@/lib/gdm-api";
import { agentJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function POST(req: NextRequest, rc: RC) {
  const { gid } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/gdm/:gid/photo", "chat", async (ctx) =>
    gdmSetPhotoApi({ email: ctx.email, userId: ctx.userId }, gid, req)
  );
  return agentJson(out);
}

export async function DELETE(req: NextRequest, rc: RC) {
  const { gid } = await rc.params;
  const out = await withAgent(req, "DELETE /api/agent/gdm/:gid/photo", "chat", async (ctx) =>
    gdmRemovePhotoApi({ email: ctx.email, userId: ctx.userId }, gid)
  );
  return agentJson(out);
}
