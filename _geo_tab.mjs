import { chromium } from "playwright";
const BASE = "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addCookies([{ name: "bsm_session", value: SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

const geo = await p.evaluate(`(() => {
  const tabs = document.querySelector('[data-cx="navtabs"]');
  const clubs = document.querySelector('[data-cx="clubbars"]');
  const seg = tabs?.querySelector('[role="group"], .mantine-SegmentedControl-root');
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return {t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height)}; };
  const header = document.querySelector('header');
  return {
    header: r(header),
    tabsBox: r(tabs),
    seg: r(seg),
    clubs: r(clubs),
    // タブバー内の上下余白
    tabPadTop: tabs ? Math.round(seg.getBoundingClientRect().top - tabs.getBoundingClientRect().top) : null,
    tabPadBottom: tabs ? Math.round(tabs.getBoundingClientRect().bottom - seg.getBoundingClientRect().bottom) : null,
    // タブと部活バーの間隔
    gapTabsToClubs: (tabs && clubs) ? Math.round(clubs.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom) : null,
  };
})()`);
console.log(JSON.stringify(geo, null, 1));
await b.close();
