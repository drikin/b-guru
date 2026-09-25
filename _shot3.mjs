import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "bsm_session", value: process.env.BSM_SESSION, domain: "bsm.backspace.fm", path: "/" }]);
const p = await ctx.newPage();
await p.goto("https://bsm.backspace.fm", { waitUntil: "networkidle" });
await p.waitForTimeout(3500);
await p.screenshot({ path: "/tmp/portrait_fixed.png" });
await b.close();
