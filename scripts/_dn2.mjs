import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(8000);

// ドリニュースのリンクをクリック
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('a')].find(e => e.textContent.includes('ドリニュース'));
  if (el) el.click();
})()`);
await page.waitForTimeout(5000);

console.log("=== ドリニュース選択後の中央領域 ===");
console.log(await page.evaluate(`(() => {
  // 中央カラム（maxWidth 640 の div）の中身
  const center = document.querySelector('div[style*="max-width: 640px"], div[style*="maxWidth: 640"]');
  const main = document.querySelector('main') || document.body;
  return JSON.stringify({
    centerFound: !!center,
    centerText: center ? center.innerText.slice(0, 300) : null,
    centerChildCount: center ? center.children.length : 0,
    // ドリニュース関連の要素が DOM にあるか
    hasDnEditor: !!document.querySelector('input[placeholder*="ドリニュースのタイトル"]'),
    hasDnList: document.body.innerText.includes('ドリニュース'),
    bodyLen: document.body.innerText.length,
  }, null, 1);
})()`));
await browser.close();
