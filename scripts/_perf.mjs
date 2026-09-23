import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
const reqs = [];
page.on("response", async (r) => {
  const req = r.request();
  reqs.push({ url: req.url(), type: req.resourceType(), status: r.status(), size: 0 });
});
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(6000);

const m = await page.evaluate(`(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const byType = {};
  for (const r of res) {
    byType[r.initiatorType] = byType[r.initiatorType] || {n:0, bytes:0, ms:0};
    byType[r.initiatorType].n++;
    byType[r.initiatorType].bytes += r.transferSize || 0;
    byType[r.initiatorType].ms += r.duration || 0;
  }
  const slow = res.filter(r => r.duration > 500).sort((a,b)=>b.duration-a.duration).slice(0,10)
    .map(r => ({url: r.name.slice(-70), ms: Math.round(r.duration), kb: Math.round((r.transferSize||0)/1024)}));
  return {
    dcl: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    ttfb: Math.round(nav.responseStart || 0),
    resources: res.length,
    totalKB: Math.round(res.reduce((s,r)=>s+(r.transferSize||0),0)/1024),
    byType,
    slow,
  };
})()`);
console.log(JSON.stringify(m, null, 1));
await browser.close();
