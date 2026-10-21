/** GET /api/agent/jukebox: ETag + 304, and a plain 200 for apps that never send If-None-Match. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM podcast_episodes")) {
        return {
          rows: [
            { id: 7, guid: "g7", title: "#313", published_at: new Date("2019-10-20T09:00:00Z"), audio_url: "https://x/a.mp3",
              audio_bytes: "1", duration_sec: 60, summary: "あ".repeat(161), series: "本編", number: 313, web_url: null },
          ],
        };
      }
      if (sql.includes("FROM jukebox_daily")) return { rows: [] };
      throw new Error("unexpected sql " + sql);
    }),
  },
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgent: async (_req: Request, _ep: string, _scope: string, h: (ctx: { email: string }) => Promise<unknown>) =>
    h({ email: "member@example.com" }),
}));
vi.mock("@/lib/agent-chat", () => ({ AGENT_API_VERSION: 1 }));

import { GET } from "@/app/api/agent/jukebox/route";
import { invalidateJukeboxCache } from "@/lib/jukebox";

const req = (h: Record<string, string> = {}) => new NextRequest("https://bsm.example/api/agent/jukebox", { headers: h });

describe("GET /api/agent/jukebox", () => {
  beforeEach(() => {
    process.env.JUKEBOX_ALLOW_EMAILS = "*";
    invalidateJukeboxCache();
  });

  it("200 with the same body shape and an ETag; 304 when If-None-Match matches", async () => {
    const r1 = await GET(req());
    expect(r1.status).toBe(200);
    const etag = r1.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"jb-/);
    expect(r1.headers.get("content-type")).toBe("application/json");
    const body = await r1.json();
    expect(body.apiVersion).toBe(1);
    expect(body.episodes[0].summary).toBe("あ".repeat(160) + "…"); // left(…,161) + clip(160): same as before
    expect(body).toHaveProperty("today"); // depends on the date; shape is covered in jukebox.test.ts

    const r2 = await GET(req({ "if-none-match": etag }));
    expect(r2.status).toBe(304);
    expect(await r2.text()).toBe("");
    expect(r2.headers.get("etag")).toBe(etag);

    // No If-None-Match (URLSession / OkHttp without a cache): full 200 every time.
    const r3 = await GET(req());
    expect(r3.status).toBe(200);
    expect((await r3.json()).episodes).toHaveLength(1);

    const r4 = await GET(req({ "if-none-match": 'W/"jb-stale"' }));
    expect(r4.status).toBe(200);
  });

  it("still 404s for members without the jukebox", async () => {
    process.env.JUKEBOX_ALLOW_EMAILS = "someone-else@example.com";
    const r = await GET(req());
    expect(r.status).toBe(404);
    expect(r.headers.get("etag")).toBeNull();
  });
});
