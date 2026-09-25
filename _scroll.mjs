import { chromium } from "playwright";
const b = await chromium.launch();
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: IPAD_UA,
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);

// スクロールして window.scrollY が動くか
const s = await p.evaluate(`(async () => {
  const out = {};
  out.beforeY = window.scrollY;
  window.scrollTo(0, 500);
  await new Promise(r=>setTimeout(r,400));
  out.afterY = window.scrollY;
  // 内部スクロール要素
  const scrollers = [...document.querySelectorAll('*')].filter(e => {
    const cs = getComputedStyle(e);
    return /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 50;
  }).slice(0,6).map(e => ({ tag: e.tagName, cls: (e.className||'').toString().slice(0,60), sh: e.scrollHeight, ch: e.clientHeight }));
  out.scrollers = scrollers;
  // body/html の高さ
  out.htmlH = document.documentElement.scrollHeight;
  out.bodyH = document.body.scrollHeight;
  out.innerH = window.innerHeight;
  return out;
})()`);
console.log(JSON.stringify(s, null, 1));
await b.close();
