import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();

// /api/drinews の呼び出しを監視
await page.addInitScript(() => {
  window.__dnCalls = [];
  const orig = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (url && url.includes('/api/drinews')) window.__dnCalls.push({ url, t: Date.now() });
    return orig.apply(this, args);
  };
});

await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(8000);
console.log("初期の /api/drinews 呼び出し:", await page.evaluate("JSON.stringify(window.__dnCalls)"));

// ドリニュースをクリック
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('a')].find(e => e.textContent.includes('ドリニュース'));
  if (el) el.click();
})()`);
await page.waitForTimeout(5000);

console.log("クリック後の /api/drinews 呼び出し:", await page.evaluate("JSON.stringify(window.__dnCalls)"));
console.log("画面:", await page.evaluate(`(() => {
  const c = document.querySelector('div[style*="max-width: 640px"], div[style*="maxWidth: 640"]');
  return c ? c.innerText.slice(0, 200) : 'not found';
})()`));
await browser.close();
