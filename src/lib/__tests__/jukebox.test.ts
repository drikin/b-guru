/** The jukebox's daily "N 年前の今日" post and rollout flag (lib/jukebox.ts), with the DB mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ daily: new Map<string, { episode_id: number; post_id: number | null }>(), posts: [] as { text: string; audio: string }[], upserts: [] as unknown[][] }));

vi.mock("@/lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT 1 FROM jukebox_daily")) return { rows: db.daily.has(params[0] as string) ? [{}] : [] };
      if (sql.includes("FROM podcast_episodes")) {
        return {
          rows: [
            // A members-only BSM 回 on the same day: never the daily pick (it goes on the timeline).
            { id: 8, guid: "bsm:a1", title: "【即日配信】アフターショー", published_at: new Date("2019-10-20T08:00:00Z"), audio_url: "https://members.example/a1.mp3",
              audio_bytes: "1", duration_sec: 1800, summary: "", series: "BSM", number: null, web_url: null },
            { id: 7, guid: "g7", title: "#313: Galaxy", published_at: new Date("2019-10-20T09:00:00Z"), audio_url: "https://verifi.podscribe.com/x.mp3",
              audio_bytes: "1", duration_sec: 9021, summary: "Pixel 4", series: "本編", number: 313, web_url: null },
          ],
        };
      }
      if (sql.includes("INSERT INTO podcast_episodes")) {
        db.upserts.push(params);
        return { rows: [] };
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

import { jukeboxBrokenClient, jukeboxEnabledFor, jukeboxForApp, postDailyIfDue, syncBsmFeed, jukeboxAppResponse, etagMatches, invalidateJukeboxCache, upsertEpisodes } from "../jukebox";
import { pool } from "@/lib/db";

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
    // BSM 回も一覧には出る（会員のアプリだけ）。毎朝の 1 本には選ばれない
    expect(r.episodes.map((e) => e.series)).toEqual(["BSM", "本編"]);
    expect(r.episodes[1]).toMatchObject({ id: "g7", title: "#313: Galaxy", duration_sec: 9021, series: "本編", number: 313, audio_url: "https://verifi.podscribe.com/x.mp3" });
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

describe("iOS builds that crash with the jukebox on", () => {
  it("are 0.2.16 to 0.2.20 only", () => {
    for (const v of ["0.2.16", "0.2.17", "0.2.18", "0.2.19", "0.2.20"]) expect(jukeboxBrokenClient(`BguruChatMac/${v}`)).toBe(true);
    for (const v of ["0.2.15", "0.2.21", "0.2.22", "0.2.200", "0.3.18", "0.3.27"]) expect(jukeboxBrokenClient(`BguruChatMac/${v}`)).toBe(false);
    expect(jukeboxBrokenClient("BguruChatAndroid/0.3.17")).toBe(false);
    expect(jukeboxBrokenClient(null)).toBe(false);
  });
});

describe("会員限定の BSM ポッドキャスト（BSM_FEED_URL）", () => {
  const SECRET = "https://members.example/feed/very-secret-token";
  const FEED = `<rss><channel><item><title>【即日配信】ep999 アフターショー</title><guid>x1</guid>
    <pubDate>Mon, 20 Oct 2026 09:00:00 -0000</pubDate><itunes:duration>00:30:00</itunes:duration>
    <enclosure url="https://members.example/x1.mp3" length="1" type="audio/mpeg"/></item></channel></rss>`;
  afterEach(() => {
    delete process.env.BSM_FEED_URL;
    db.upserts.length = 0;
  });

  it("URL が無ければ何もしない", async () => {
    const f = vi.fn();
    expect(await syncBsmFeed(f as unknown as typeof fetch)).toEqual({ changed: false, episodes: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("系列 BSM・guid は bsm: 付きで取り込む", async () => {
    process.env.BSM_FEED_URL = SECRET;
    const f = vi.fn(async () => new Response(FEED, { status: 200 }));
    expect(await syncBsmFeed(f as unknown as typeof fetch)).toEqual({ changed: true, episodes: 1 });
    const [guids, , , , , , , series] = db.upserts[0] as string[][];
    expect(guids).toEqual(["bsm:x1"]);
    expect(series).toEqual(["BSM"]);
  });

  it("失敗しても URL をエラーに出さない（ログに残さない）", async () => {
    process.env.BSM_FEED_URL = SECRET;
    const bad = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(syncBsmFeed(bad as unknown as typeof fetch)).rejects.toThrow("bsm feed 403");
    const down = vi.fn(async () => { throw new Error(`fetch failed: ${SECRET}`); });
    const err = await syncBsmFeed(down as unknown as typeof fetch).catch((e: Error) => e.message);
    expect(err).toBe("bsm feed unreachable");
    expect(String(err)).not.toContain("secret");
  });
});

describe("アプリ向けの一覧はメモリに持ち、ETag で 304 を返せる", () => {
  const listCalls = () =>
    (pool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes("left(summary, 161)")).length;
  beforeEach(() => invalidateJukeboxCache());

  it("summary は SQL で 161 字だけ読み、一覧は 1 回だけ作る", async () => {
    const before = listCalls();
    const a = await jukeboxAppResponse(1);
    const b = await jukeboxAppResponse(1);
    expect(listCalls() - before).toBe(1);
    expect(a.json).toBe(b.json);
    expect(a.etag).toBe(b.etag);
    const body = JSON.parse(a.json);
    expect(Object.keys(body)).toEqual(["apiVersion", "episodes", "today"]);
    expect(body.apiVersion).toBe(1);
    expect(body.episodes.map((e: { id: string }) => e.id)).toEqual(["bsm:a1", "g7"]);
    // Same DTO as jukeboxForApp (the shape the apps already parse).
    expect(body.episodes).toEqual((await jukeboxForApp()).episodes);
  });

  it("取り込み（upsert）で作り直す", async () => {
    await jukeboxAppResponse(1);
    const before = listCalls();
    await upsertEpisodes([]);
    await jukeboxAppResponse(1);
    expect(listCalls() - before).toBe(1);
  });

  it("If-None-Match の比較（弱い ETag・リスト・*）", async () => {
    const { etag } = await jukeboxAppResponse(1);
    expect(etag.startsWith('W/"')).toBe(true);
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(etag.slice(2), etag)).toBe(true); // strong form of the same tag
    expect(etagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches(null, etag)).toBe(false); // URLSession / OkHttp without a cache: plain 200
    expect(etagMatches('W/"jb-different"', etag)).toBe(false);
  });
});
