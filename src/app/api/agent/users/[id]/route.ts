/* GET /api/agent/users/:user_id — 会員のプロフィール（スコープ read）。Web の #/user/<id>（GET /api/user/[id]）と同じ中身を
 * snake_case で。email は本人にも返さない（アプリは要らない）。その人の投稿は GET /api/agent/posts?author_user_id=…。
 * 2026-11-12 フィードバック「アプリはタイムラインのアイコンをタップしてもプロフィールが見られない」。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { getProfile } from "@/lib/profile";
import { userIdToEmail } from "@/lib/user";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const out = await withAgent(req, "GET /api/agent/users/:id", "read", async (ctx) => {
    const email = /^[A-Za-z0-9_-]{4,64}$/.test(id) ? await userIdToEmail(id) : null;
    const p = email ? await getProfile(email) : null;
    if (!email || !p) return { status: 404, body: { error: "ユーザーが見つかりません", code: "not_found" }, headers: NO_CACHE };
    return {
      status: 200,
      body: {
        apiVersion: 1,
        profile: {
          user_id: p.userId ?? id,
          is_self: ctx.userId === (p.userId ?? id),
          name: p.name,
          avatar: p.avatar,
          bio: p.bio,
          header_image: p.headerImage,
          links: p.links.map((l) => ({ label: l.label, href: l.href })),
          post_count: p.postCount,
          first_post_at: p.firstPostAt,
        },
      },
      headers: NO_CACHE,
    };
  });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json", ...NO_CACHE } });
}
