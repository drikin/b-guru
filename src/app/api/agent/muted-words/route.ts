/* NG ワード（本人の設定。Web の /api/muted-words と同じ表）。
 *   GET /api/agent/muted-words                → { apiVersion, words, max, maxLength }（スコープ read）
 *   PUT /api/agent/muted-words { words: [...] } → { apiVersion, words }（一覧ごと置き換え）
 * 書き換えはアプリのログインで発行した鍵（app_issued）＋ post だけ。枠は post_light。
 * 言葉を含むほかの人の投稿・返信はタイムラインに出ず、知らせも来ない（自分の投稿は出る）。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { getMutedWordsApi, setMutedWordsApi } from "@/lib/muted-words";
import { BAD_JSON, agentJson, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/muted-words", "read", (ctx) => getMutedWordsApi(ctx.email));
  return agentJson(out);
}

export async function PUT(req: NextRequest) {
  const out = await withAgent(req, "PUT /api/agent/muted-words", "post", async (ctx) => {
    requireAppIssued(ctx);
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    return setMutedWordsApi(ctx.email, body);
  }, { lightPost: true });
  return agentJson(out);
}
