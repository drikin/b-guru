import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0,200)); });

await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(8000);

console.log("=== ナビゲーション項目 ===");
console.log(await page.evaluate(`(() => {
  const navs = [...document.querySelectorAll('a, button')].filter(e => /ドリニュース|タイムライン|チャット/.test(e.textContent));
  return JSON.stringify(navs.map(e => ({ tag: e.tagName, text: e.textContent.trim().slice(0,20) })), null, 1);
})()`));

// ドリニュースをクリック
console.log("\n=== ドリニュースをクリック ===");
const clicked = await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('a, button')].find(e => e.textContent.includes('ドリニュース'));
  if (!el) return 'not found';
  el.click();
  return 'clicked';
})()`);
console.log(clicked);
await page.waitForTimeout(5000);

console.log("\n=== クリック後の状態 ===");
console.log(await page.evaluate(`(() => {
  const body = document.body.innerText;
  return JSON.stringify({
    hasDrinewsText: body.includes('ドリニュース'),
    bodySnippet: body.slice(0, 400),
    url: location.href,
  }, null, 1);
})()`));

console.log("\n=== エラー ===");
console.log(JSON.stringify(errs.slice(0, 5), null, 1));
await browser.close();
