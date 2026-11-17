/* POST   /api/agent/profile/avatar — 自分のアイコンを上げる（スコープ post）。multipart の image（1 枚）→ { avatar, custom: true }
 * DELETE /api/agent/profile/avatar — 上げたアイコンを消して Gravatar に戻す → { avatar, custom: false }
 * 中身は Web の /api/profile/avatar と同じ lib/custom-avatar.ts（正方形の JPEG・EXIF なし）。
 * 今が上げたものかは GET /api/agent/users/:自分 の profile.avatar_custom（本人にだけ付く）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { CUSTOM_AVATAR_MAX_BYTES, deleteCustomAvatar, saveCustomAvatar } from "@/lib/custom-avatar";
import { agentJson, NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 上げ直しは 1 時間に 20 回まで（Web と別に数える。pm2 は 1 プロセス）。
const recent = new Map<string, number[]>();
function rateOk(key: string): boolean {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= 20) return false;
  list.push(now);
  recent.set(key, list);
  return true;
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/profile/avatar", "post", async (ctx) => {
    if (!rateOk(ctx.email.toLowerCase()))
      return { status: 429, body: { error: "少し時間をおいてからもう一度どうぞ", code: "rate_limited" }, headers: NO_CACHE };
    let file: File | null = null;
    try {
      const f = (await req.formData()).get("image");
      if (f && typeof f !== "string") file = f;
    } catch {
      return { status: 400, body: { error: "画像を読めませんでした", code: "invalid_request" }, headers: NO_CACHE };
    }
    if (!file) return { status: 400, body: { error: "画像が選択されていません", code: "invalid_request" }, headers: NO_CACHE };
    if (file.size > CUSTOM_AVATAR_MAX_BYTES)
      return { status: 413, body: { error: "画像が大きすぎます（10MB まで）", code: "too_large" }, headers: NO_CACHE };
    try {
      const avatar = await saveCustomAvatar(ctx.email, Buffer.from(await file.arrayBuffer()));
      return { status: 200, body: { avatar, custom: true }, headers: NO_CACHE };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "アイコンを保存できませんでした";
      return { status: 400, body: { error: msg, code: "unsupported" }, headers: NO_CACHE };
    }
  });
  return agentJson(out);
}

export async function DELETE(req: NextRequest) {
  const out = await withAgent(req, "DELETE /api/agent/profile/avatar", "post", async (ctx) => {
    const avatar = await deleteCustomAvatar(ctx.email);
    return { status: 200, body: { avatar, custom: false }, headers: NO_CACHE };
  });
  return agentJson(out);
}
