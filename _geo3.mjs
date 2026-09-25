import { chromium } from "playwright";
const BASE = "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await ctx.addCookies([{ name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
// 実測: 各要素の境界を数値で出す
const geo = await p.evaluate(`(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return {t: Math.round(b.top), b: Math.round(b.bottom)}; };
  const tabs = document.querySelector('[data-cx="navtabs"]');
  const clubs = document.querySelector('[data-cx="clubbars"]');
  const seg = tabs?.querySelector('[role="group"], .mantine-SegmentedControl-root');
  const header = document.querySelector('header');
  const hb = header.getBoundingClientRect().bottom;
  const tb = tabs.getBoundingClientRect();
  const sb = seg.getBoundingClientRect();
  const cb = clubs.getBoundingClientRect();
  return {
    headerBottom: Math.round(hb),
    tabsTop: Math.round(tb.top), tabsBottom: Math.round(tb.bottom),
    segTop: Math.round(sb.top), segBottom: Math.round(sb.bottom),
    clubsTop: Math.round(cb.top),
    "A: header→seg": Math.round(sb.top - hb),
    "B: seg→tabsBottom": Math.round(tb.bottom - sb.bottom),
    "C: tabsBottom→clubs": Math.round(cb.top - tb.bottom),
  };
})()`);
console.log(JSON.stringify(geo, null, 1));
await p.screenshot({ path: "/tmp/tab_after2.png", clip: { x: 0, y: 0, width: 390, height: 200 } });
await b.close();
