import { chromium } from "playwright";
import fs from "fs";
const token = fs.readFileSync("/tmp/meas_token.txt", "utf8").trim();
const b = await chromium.launch();
for (const w of [1440, 1024, 900, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  await ctx.addCookies([{ name: "bsm_session", value: token, domain: "bsm.backspace.fm", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto("https://bsm.backspace.fm/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const club = document.querySelector('[data-cx="clubbars"]');
    const tab = document.querySelector('[data-cx="navtabs"]');
    const vis = (e) => { if (!e) return null; const cs = getComputedStyle(e); return { h: e.offsetHeight, display: cs.display, visibility: cs.visibility, top: Math.round(e.getBoundingClientRect().top) }; };
    return { club: vis(club), tab: vis(tab) };
  });
  console.log(w + "px:", JSON.stringify(r));
  await ctx.close();
}
await b.close();
