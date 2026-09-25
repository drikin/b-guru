import { chromium } from "playwright";
const b = await chromium.launch();
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ctx = await b.newContext({
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD_UA,
});
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);

// スクロールコンテナは window か、それとも内部 div か？
const scrollInfo = await p.evaluate(`(() => {
  const de = document.documentElement;
  const body = document.body;
  // 内部スクロールする要素を探す
  const scrollers = [...document.querySelectorAll('*')].filter(e => {
    const s = getComputedStyle(e);
    return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 20;
  }).slice(0, 5).map(e => ({
    tag: e.tagName, cls: (e.className||'').toString().slice(0,50),
    sh: e.scrollHeight, ch: e.clientHeight,
  }));
  return {
    windowScrollY: window.scrollY,
    docScrollHeight: de.scrollHeight, docClientHeight: de.clientHeight,
    bodyScrollHeight: body.scrollHeight,
    windowScrollable: de.scrollHeight > de.clientHeight + 20,
    innerScrollers: scrollers,
  };
})()`);
console.log(JSON.stringify(scrollInfo, null, 1));
await b.close();
