import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollBy(0, 6000));
await page.waitForTimeout(1000);
await page.evaluate(`(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  btns.find(x => x.textContent && x.textContent.includes('チャット')).click();
})()`);
await page.waitForTimeout(3000);

// 構造を調べる
console.log("=== チャットの DOM 構造 ===");
console.log(await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  const inner = vp.firstElementChild;
  return {
    vpTag: vp.tagName,
    vpClass: vp.className.slice(0, 80),
    innerTag: inner ? inner.tagName : null,
    innerClass: inner ? inner.className.slice(0, 80) : null,
    innerChildren: inner ? inner.children.length : 0,
    vpScrollHeight: vp.scrollHeight,
    vpClientHeight: vp.clientHeight,
    innerScrollHeight: inner ? inner.scrollHeight : null,
    innerClientHeight: inner ? inner.clientHeight : null,
  };
})()`));

// ResizeObserver が発火するか直接テスト
console.log("\n=== ResizeObserver の発火テスト ===");
console.log(await page.evaluate(`(async () => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  const inner = vp.firstElementChild;
  let fired = 0;
  const ro = new ResizeObserver(() => { fired++; });
  ro.observe(inner);
  await new Promise(r => setTimeout(r, 200));
  const before = fired;
  const d = document.createElement('div');
  d.style.height = '400px';
  inner.appendChild(d);
  await new Promise(r => setTimeout(r, 500));
  ro.disconnect();
  return {firedBefore: before, firedAfter: fired, innerH: inner.scrollHeight, vpH: vp.scrollHeight};
})()`));
await browser.close();
