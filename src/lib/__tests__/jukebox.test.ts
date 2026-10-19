/** The jukebox's daily "N 年前の今日" post and rollout flag (lib/jukebox.ts), with the DB mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ daily: new Map<string, { episode_id: number; post_id: number | null }>(), posts: [] as { text: string; audio: string }[] }));

vi.mock("@/lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT 1 FROM jukebox_daily")) return { rows: db.daily.has(params[0] as string) ? [{}] : [] };
      if (sql.includes("FROM podcast_episodes")) {
        return {
          rows: [
            { id: 7, guid: "g7", title: "#313: Galaxy", published_at: new Date("2019-10-20T09:00:00Z"), audio_url: "https://verifi.podscribe.com/x.mp3",
              audio_bytes: "1", duration_sec: 9021, summary: "Pixel 4", series: "本編", number: 313, web_url: null },
          ],
        };
      }
      if (sql.includes("INSERT INTO jukebox_daily")) {
        if (db.daily.has(params[0] as string)) return { rows: [] };
        db.daily.set(params[0] as string, { episode_id: params[1] as number, post_id: null });
        return { rows: [{ day: params[0] }] };
      }
      if (sql.includes("INSERT INTO posts")) {
        db.posts.push({ text: params[2] as string, audio: params[3] as string });
        return { rows: [{ id: 100 + db.posts.length }] };
      }
      if (sql.includes("UPDATE jukebox_daily")) {
        db.daily.get(params[0] as string)!.post_id = params[1] as number;
        return { rows: [] };
      }
      if (sql.includes("SELECT episode_id, post_id FROM jukebox_daily")) {
        const d = db.daily.get(params[0] as string);
        return { rows: d ? [d] : [] };
      }
      throw new Error("unexpected sql " + sql);
    }),
  },
}));

import { jukeboxEnabledFor, jukeboxForApp, postDailyIfDue } from "../jukebox";

describe("daily post", () => {
  beforeEach(() => {
    db.daily.clear();
    db.posts.length = 0;
    delete process.env.JUKEBOX_DAILY_POST;
  });

  it("waits for 7:00 in Japan, then posts once a day with the episode's audio", async () => {
    expect(await postDailyIfDue(new Date("2026-10-19T21:59:00Z"))).toBeNull(); // 6:59 JST on 10/20
    expect(await postDailyIfDue(new Date("2026-10-19T22:00:00Z"))).toBe(101);
    expect(await postDailyIfDue(new Date("2026-10-20T03:00:00Z"))).toBeNull(); // same day: nothing more
    expect(db.posts).toHaveLength(1);
    expect(db.posts[0].text.split("\n")[0]).toBe("📅 7 年前の今日の backspace.fm");
    expect(db.posts[0].audio).toBe("https://verifi.podscribe.com/x.mp3");
    expect(db.daily.get("2026-10-20")).toEqual({ episode_id: 7, post_id: 101 });
  });

  it("can be switched off", async () => {
    process.env.JUKEBOX_DAILY_POST = "0";
    expect(await postDailyIfDue(new Date("2026-10-19T22:00:00Z"))).toBeNull();
    expect(db.posts).toHaveLength(0);
  });

  it("the apps get every episode and today's pick with its post", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T23:00:00Z"));
    await postDailyIfDue();
    const r = await jukeboxForApp();
    expect(r.episodes[0]).toMatchObject({ id: "g7", title: "#313: Galaxy", duration_sec: 9021, series: "本編", number: 313, audio_url: "https://verifi.podscribe.com/x.mp3" });
    expect(r.today).toEqual({ id: "g7", years_ago: 7, post_id: 101 });
    vi.useRealTimers();
  });
});

describe("rollout flag", () => {
  afterEach(() => delete process.env.JUKEBOX_ALLOW_EMAILS);
  it("only the listed members, or everyone with *", () => {
    expect(jukeboxEnabledFor("a@x.jp")).toBe(false);
    process.env.JUKEBOX_ALLOW_EMAILS = "A@x.jp, b@x.jp";
    expect(jukeboxEnabledFor("a@x.jp")).toBe(true);
    expect(jukeboxEnabledFor("c@x.jp")).toBe(false);
    process.env.JUKEBOX_ALLOW_EMAILS = "*";
    expect(jukeboxEnabledFor("c@x.jp")).toBe(true);
    expect(jukeboxEnabledFor(null)).toBe(false);
  });
});
