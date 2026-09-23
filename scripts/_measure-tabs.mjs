import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/", secure: true, httpOnly: true }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(4000);

const measure = `(() => {
  const tabs = document.querySelector('[data-cx="navtabs"]');
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const feed = document.querySelector('[class*="bguru-feed"], main');
  const r = (e) => e ? {top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height)} : null;
  return {
    windowScrollY: Math.round(window.scrollY),
    tabs: r(tabs),
    chat: r(chat),
    feed: r(feed),
    tabsStyle: tabs ? {position: getComputedStyle(tabs).position, top: getComputedStyle(tabs).top, zIndex: getComputedStyle(tabs).zIndex} : null,
  };
})()`;

console.log("=== タイムライン表示中 ===");
console.log(await page.evaluate(measure));

await page.evaluate(`(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  btns.find(x => x.textContent && x.textContent.includes('チャット')).click();
})()`);
await page.waitForTimeout(4000);

console.log("\n=== チャット表示中 ===");
console.log(await page.evaluate(measure));

console.log("\n=== タブを戻す ===");
await page.evaluate(`(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  btns.find(x => x.textContent && x.textContent.includes('タイムライン')).click();
})()`);
await page.waitForTimeout(3000);
console.log(await page.evaluate(measure));
await browser.close();
