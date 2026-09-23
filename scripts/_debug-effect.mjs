import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollBy(0, 6000));
await page.waitForTimeout(1000);

// ResizeObserver の生成/切断をフック
await page.evaluate(`(() => {
  window.__roLog = [];
  const OrigRO = window.ResizeObserver;
  window.ResizeObserver = class extends OrigRO {
    constructor(cb) {
      super(cb);
      window.__roLog.push({t: Date.now(), ev: 'create'});
      this.__id = window.__roLog.length;
    }
    observe(...a) { window.__roLog.push({t: Date.now(), ev: 'observe'}); return super.observe(...a); }
    disconnect() { window.__roLog.push({t: Date.now(), ev: 'disconnect'}); return super.disconnect(); }
  };
})()`);

await page.evaluate(`(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  btns.find(x => x.textContent && x.textContent.includes('チャット')).click();
})()`);
await page.waitForTimeout(5000);

console.log("=== ResizeObserver の生成/切断ログ ===");
console.log(await page.evaluate(`JSON.stringify(window.__roLog || [], null, 1)`));
await browser.close();
