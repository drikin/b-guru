import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollBy(0, 6000));
await page.waitForTimeout(1000);

// scroll イベントを監視
await page.evaluate(`(() => {
  window.__scrollLog = [];
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  if (chat) {
    const vp = chat.querySelector('.mantine-ScrollArea-viewport');
    vp.addEventListener('scroll', () => {
      window.__scrollLog.push({t: Date.now(), st: Math.round(vp.scrollTop), sh: Math.round(vp.scrollHeight)});
    }, {passive: true});
  }
})()`);

await page.evaluate(`(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  btns.find(x => x.textContent && x.textContent.includes('チャット')).click();
})()`);
await page.waitForTimeout(3000);

console.log("=== チャットを開いた直後の scroll イベント ===");
console.log(await page.evaluate(`JSON.stringify(window.__scrollLog || [])`));

console.log("\n=== 成長を注入 ===");
console.log(await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  const inner = vp.firstElementChild;
  const before = {st: Math.round(vp.scrollTop), sh: Math.round(vp.scrollHeight), dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight)};
  const d = document.createElement('div');
  d.style.height = '400px';
  inner.appendChild(d);
  return {before, after: {sh: Math.round(vp.scrollHeight)}};
})()`));
await page.waitForTimeout(1500);

console.log("\n=== 成長後 ===");
console.log(await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  return {
    st: Math.round(vp.scrollTop),
    sh: Math.round(vp.scrollHeight),
    dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
    scrollEvents: (window.__scrollLog || []).length,
    lastEvents: (window.__scrollLog || []).slice(-5),
  };
})()`));
await browser.close();
