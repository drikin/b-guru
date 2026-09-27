import { chromium } from "playwright";
import fs from "fs";
const token = fs.readFileSync("/tmp/meas_token.txt", "utf8").trim();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "bsm_session", value: token, domain: "bsm.backspace.fm", path: "/" }]);
const page = await ctx.newPage();
await page.goto("https://bsm.backspace.fm/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const r = await page.evaluate(() => {
  const club = document.querySelector('[data-cx="clubbars"]');
  const tab = document.querySelector('[data-cx="navtabs"]');
  const cs = getComputedStyle(club);
  const tcs = getComputedStyle(tab);
  return {
    tab: { top: tcs.top, h: tab.offsetHeight, rectTop: Math.round(tab.getBoundingClientRect().top), rectBottom: Math.round(tab.getBoundingClientRect().bottom) },
    club: { top: cs.top, h: club.offsetHeight, rectTop: Math.round(club.getBoundingClientRect().top), rectBottom: Math.round(club.getBoundingClientRect().bottom), padBottom: cs.paddingBottom },
    scrollY: Math.round(window.scrollY),
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
