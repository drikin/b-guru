/** The jukebox's reading of the Art19 feed and the daily "N 年前の今日" pick (lib/jukebox-feed.ts). */
import { describe, it, expect } from "vitest";
import { dailyPostText, jstDay, numberOf, parseArt19, parseDuration, pickForDay, seriesOf, summaryOf } from "../jukebox-feed";

const item = (o: { guid: string; title: string; date: string; dur?: string; desc?: string; url?: string }) => `
  <item>
    <title>${o.title}</title>
    <description><![CDATA[${o.desc ?? "<p>本文</p>"}]]></description>
    <guid isPermaLink="false">${o.guid}</guid>
    <pubDate>${o.date}</pubDate>
    <itunes:duration>${o.dur ?? "01:00:00"}</itunes:duration>
    <enclosure url="${o.url ?? "https://verifi.podscribe.com/rss/p/dts.podtrac.com/redirect.mp3/rss.art19.com/episodes/x.mp3?rss_browser=a&amp;b=1"}" length="47329280" type="audio/mpeg"/>
  </item>`;

const FEED = `<?xml version="1.0"?><rss><channel><title>backspace.fm</title>
${item({ guid: "g1", title: "#001: backspace.fm始まりました！", date: "Fri, 03 Jan 2014 10:00:00 -0000", dur: "00:49:18",
  desc: '<p>このページをウェブブラウザで見る: <a href="https://backspace.fm/episode/001/">リンク</a><br></p><p>backspace.fmは、1週間分のテック系トピックをまとめて紹介するポッドキャストです。キャスターは、ドリキンと @mazzo さんが担当します。\n記念すべき第1回は CES &amp; ガジェット</p>' })}
${item({ guid: "g2", title: "B-side #037: 秋の夜長", date: "Sun, 20 Oct 2019 09:00:00 -0000" })}
${item({ guid: "g3", title: "獣の数字回 — Z Fold8 ep666", date: "Sun, 04 Oct 2026 09:00:00 -0000", dur: "02:04:10" })}
${item({ guid: "g4", title: "no audio", date: "Sun, 04 Oct 2026 09:00:00 -0000", url: "javascript:alert(1)" })}
</channel></rss>`;

describe("parseArt19", () => {
  const eps = parseArt19(FEED);

  it("reads every episode with audio, newest first, keeping the counted URL as it is", () => {
    expect(eps.map((e) => e.guid)).toEqual(["g3", "g2", "g1"]); // the javascript: one is dropped
    expect(eps[2].audioUrl).toBe("https://verifi.podscribe.com/rss/p/dts.podtrac.com/redirect.mp3/rss.art19.com/episodes/x.mp3?rss_browser=a&b=1");
    expect(eps[2].durationSec).toBe(49 * 60 + 18);
    expect(eps[0].durationSec).toBe(2 * 3600 + 4 * 60 + 10);
    expect(eps[2].publishedAt).toBe("2014-01-03T10:00:00.000Z");
  });

  it("drops the boilerplate from the summary and finds the backspace.fm page", () => {
    expect(eps[2].summary).toBe("記念すべき第1回は CES & ガジェット");
    expect(eps[2].webUrl).toBe("https://backspace.fm/episode/001/");
    expect(eps[1].webUrl).toBeNull();
  });

  it("names the series and the number", () => {
    expect(eps.map((e) => [e.series, e.number])).toEqual([["本編", 666], ["B-side", 37], ["本編", 1]]);
  });
});

describe("small readers", () => {
  it("durations", () => {
    expect(parseDuration("02:04:10")).toBe(7450);
    expect(parseDuration("5:00")).toBe(300);
    expect(parseDuration("3725")).toBe(3725);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("x")).toBeNull();
  });
  it("series and numbers", () => {
    expect(seriesOf("DANBO-side #90: iPhone Duo")).toBe("DANBO-side");
    expect(seriesOf("TechnoeEdge-side #3")).toBe("TechnoEdge-side");
    expect(seriesOf("VidCon-side 2")).toBe("VidCon-side");
    expect(numberOf("【BSM447】WWDC")).toBeNull();
    expect(numberOf("#497:【前編】")).toBe(497);
    expect(numberOf("西川善司の超RTX Spark解説！ ep677")).toBe(677);
  });
  it("summary keeps line breaks, drops tags", () => {
    expect(summaryOf("<p>一行目<br>二行目</p><p>三&amp;四</p>")).toBe("一行目\n二行目\n三&四");
  });
  it("the day in Japan", () => {
    expect(jstDay(new Date("2026-10-19T15:30:00Z"))).toBe("2026-10-20");
    expect(jstDay(new Date("2026-10-19T14:59:00Z"))).toBe("2026-10-19");
  });
});

describe("pickForDay", () => {
  const ep = (guid: string, publishedAt: string, series = "本編") => ({ guid, publishedAt, series });
  const eps = [
    ep("a", "2019-10-20T00:00:00Z"),
    ep("b", "2016-10-20T03:00:00Z", "B-side"),
    ep("c", "2021-10-23T00:00:00Z"),
    ep("d", "2026-10-20T00:00:00Z"), // this year: never
  ];

  it("takes the same day in an earlier year, 本編 first, the same pick all day", () => {
    expect(pickForDay(eps, "2026-10-20")?.guid).toBe("a");
    expect(pickForDay(eps, "2026-10-20")?.guid).toBe(pickForDay(eps, "2026-10-20")?.guid);
  });
  it("falls back to the nearest day within a week, across the new year too", () => {
    expect(pickForDay(eps, "2026-10-22")?.guid).toMatch(/^[ac]$/);
    expect(pickForDay([ep("x", "2019-12-30T00:00:00Z")], "2026-01-02")?.guid).toBe("x");
    expect(pickForDay(eps, "2026-04-01")).toBeNull();
  });
  it("uses the Japanese date of the episode", () => {
    // 2019-10-19 20:00 UTC is 10/20 in Japan
    expect(pickForDay([ep("j", "2019-10-19T20:00:00Z")], "2026-10-20")?.guid).toBe("j");
  });
});

describe("dailyPostText", () => {
  it("says how long ago, the title, date and length, a short summary, and how to listen", () => {
    const t = dailyPostText(
      { title: "#283: 秋のApple", publishedAt: "2019-10-20T09:00:00Z", durationSec: 6753, summary: "あ".repeat(200), webUrl: "https://backspace.fm/episode/283/" },
      "2026-10-20"
    );
    expect(t.split("\n")[0]).toBe("📅 7 年前の今日の backspace.fm");
    expect(t).toContain("**#283: 秋のApple**");
    expect(t).toContain("2019.10.20 ・ 1:52:33");
    expect(t).toContain("あ".repeat(140) + "…");
    expect(t).toContain("下の再生ボタンで聴けます");
    expect(t.trim().endsWith("https://backspace.fm/episode/283/")).toBe(true);
    expect(dailyPostText({ title: "x", publishedAt: "2019-10-22T09:00:00Z", durationSec: null, summary: "", webUrl: null }, "2026-10-20").split("\n")[0])
      .toBe("📅 7 年前の今ごろの backspace.fm");
  });
});
