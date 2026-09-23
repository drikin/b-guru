#!/usr/bin/env node
/**
 * E2E regression guard for the B-guru portal.
 *
 * Why this exists: the chat scroll bug regressed twice. The first fix
 * ("never scroll on tab open") was correct for the report it answered and
 * wrong for the next one, and no unit test could catch it because the bug
 * only appears in a real browser with a real layout. Static source checks
 * (chat-scroll.test.ts) pin the *shape* of the fix; this script pins the
 * *behaviour*.
 *
 * It drives a real Chromium against a running instance and asserts the
 * user-visible outcomes drikin reported. Run it against production after
 * every deploy, and against a local build in CI.
 *
 * Usage:
 *   node scripts/e2e-regression.mjs                    # against production
 *   BASE_URL=http://localhost:3000 node scripts/e2e-regression.mjs
 *
 * Requires a session token in BSM_SESSION (see the skill for how to mint one).
 */

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "https://bsm.backspace.fm";
const SESSION = process.env.BSM_SESSION;
const HEADLESS = process.env.HEADLESS !== "0";

if (!SESSION) {
  console.error("BSM_SESSION is required (a valid bsm_session token).");
  process.exit(2);
}

const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Distance from the bottom of the chat list, in px. 0 = pinned to bottom. */
const CHAT_DIST = `(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  if (!chat) return null;
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  if (!vp) return null;
  return {
    scrollTop: Math.round(vp.scrollTop),
    scrollHeight: Math.round(vp.scrollHeight),
    clientHeight: Math.round(vp.clientHeight),
    dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
  };
})()`;

/** Click the タイムライン / チャット segmented control. */
const clickTab = (label) => `(() => {
  const btns = [...document.querySelectorAll('label, button, [role="radio"]')];
  const b = btns.find(x => x.textContent && x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return false;
  b.click();
  return true;
})()`;

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
await context.addCookies([
  {
    name: "bsm_session",
    value: SESSION,
    domain: new URL(BASE_URL).hostname,
    path: "/",
    secure: BASE_URL.startsWith("https"),
    httpOnly: true,
  },
]);

const page = await context.newPage();
const consoleErrors = [];
const notFound = [];
// Console messages for failed subresources carry no URL, so correlate with the
// response event: a 404 from /api/avatar/<md5> is EXPECTED (the member has no
// Gravatar and SafeAvatar falls back to the initial-letter placeholder; the
// proxy caches the negative result). Counting it as an error would make this
// guard cry wolf on every run.
const expected404 = new Set();
page.on("response", (r) => {
  if (r.status() === 404 && /\/api\/avatar\/[a-f0-9]{32}/.test(r.url())) {
    expected404.add(r.url());
  }
});
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text().slice(0, 200);
  if (/Failed to load resource/.test(text) && expected404.size > 0) {
    notFound.push(text);
    return;
  }
  consoleErrors.push(text);
});

console.log(`\n=== B-guru E2E regression guard ===`);
console.log(`target: ${BASE_URL}\n`);

// ---------------------------------------------------------------- load
console.log("1. Initial load");
await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);

const bodyText = await page.evaluate(() => document.body.innerText);
check("page renders (no client crash)", !/couldn't load/i.test(bodyText), `${bodyText.length} chars`);
check("timeline is visible", /タイムライン/.test(bodyText));
check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

// ------------------------------------------------- chat scroll: open at bottom
console.log("\n2. Chat opens at the bottom (drikin 2026-09-23)");
// Scroll the timeline down first — this is the exact precondition reported.
await page.evaluate(() => window.scrollBy(0, 6000));
await page.waitForTimeout(1200);
const timelineScroll = await page.evaluate(() => Math.round(window.scrollY));
check("timeline scrolled down", timelineScroll > 1000, `scrollY=${timelineScroll}`);

await page.evaluate(clickTab("チャット"));
// Poll rather than sleep: the chat list mounts, then the messages load, then
// the open-transition pin settles. How long that takes varies with the machine.
let d = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(250);
  d = await page.evaluate(CHAT_DIST);
  if (d && d.dist < 5) break;
}
check("chat list exists", d !== null);
if (!d) {
  // Without the chat list we cannot verify anything below — fail hard rather
  // than silently skipping, so a broken build never looks like a pass.
  console.log("\nFATAL: chat list not found; cannot verify scroll behaviour.");
  await browser.close();
  process.exit(1);
}
check("chat opens pinned to the bottom", d.dist < 5, `dist=${d.dist}px`);

// Record the pin state right after opening, before anything else runs. If the
// pin is already released here, the failure downstream is not about the
// observer at all — it is about the open transition not holding.
const pinAfterOpen = await page.evaluate(`(() => window.__e2ePinProbe ? window.__e2ePinProbe() : null)()`);
console.log("  [diag] pin right after open: " + JSON.stringify(pinAfterOpen));
// Start recording every scroll event from here on, so a later failure can name
// the exact event that released the pin.
await page.evaluate(`(() => { window.__e2eScrollLog = []; })()`);

// ------------------------------------------- chat scroll: late content settles
console.log("\n3. Stays at the bottom while late content loads");
// Let images/avatars land, then confirm the list is still pinned.
let stillPinned = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  stillPinned = await page.evaluate(CHAT_DIST);
  if (stillPinned && stillPinned.dist >= 5) break; // drifted — stop early
}
check(
  "still at the bottom after images/avatars settle",
  !!stillPinned && stillPinned.dist < 5,
  `dist=${stillPinned?.dist}px`
);

// 3b. Force late content growth. This is the part that actually catches the
// regression: on a warm cache the avatars/images are already loaded, so the
// fixed 60/240ms timers alone are enough and a missing ResizeObserver would
// pass unnoticed. Injecting a tall node AFTER those timers have fired proves
// the list keeps pinning as content grows.
console.log("\n3b. Keeps pinning when content grows after the settle timers");
const grew = await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  const inner = vp.firstElementChild;
  if (!inner) return null;
  const before = vp.scrollHeight;
  const d = document.createElement('div');
  d.id = '__e2e_growth';
  d.style.height = '400px';
  d.style.flex = '0 0 auto';
  inner.appendChild(d);
  return { before, after: vp.scrollHeight };
})()`);
check("growth injected", grew !== null && grew.after > grew.before, grew ? `${grew.before} → ${grew.after}` : "no inner");
// ResizeObserver fires asynchronously, and how long it takes varies with the
// machine (measured: settled by +300ms locally, later on a CI runner). Poll
// instead of sleeping a fixed amount, so the check tests the behaviour rather
// than the runner's speed.
let settled = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  settled = await page.evaluate(CHAT_DIST);
  if (settled && settled.dist < 5) break;
}
// Diagnostics: when this check fails, the numbers below say WHY. A dist that
// equals the injected height means the observer never ran; a dist that shrinks
// slowly means it ran but was too late; scrollTop moving means something
// scrolled the list.
if (!settled || settled.dist >= 5) {
  const diag = await page.evaluate(`(() => {
    const chat = document.querySelector('[class*="bguru-chat-view"]');
    const vp = chat.querySelector('.mantine-ScrollArea-viewport');
    const inner = vp.firstElementChild;
    // Count how many ResizeObservers the app created and whether any of them
    // is still connected. Patch the constructor BEFORE the app runs is not
    // possible here, so instead: does a fresh observer on the same target fire?
    // (yes => the browser is fine, so the app's observer must be gone or
    //  watching something else)
    return new Promise((resolve) => {
      let mineFired = 0;
      const ro = new ResizeObserver(() => { mineFired++; });
      ro.observe(inner);
      const d2 = document.createElement('div');
      d2.style.height = '200px';
      d2.style.flex = '0 0 auto';
      inner.appendChild(d2);
      setTimeout(() => {
        ro.disconnect();
        resolve({
          scrollTop: Math.round(vp.scrollTop),
          scrollHeight: Math.round(vp.scrollHeight),
          clientHeight: Math.round(vp.clientHeight),
          dist: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
          growthPresent: !!document.getElementById('__e2e_growth'),
          growthHeight: document.getElementById('__e2e_growth')?.offsetHeight ?? null,
          innerIsVpChild: vp.contains(inner),
          innerClass: inner?.className ?? null,
          myObserverFired: mineFired,
          // Is the app's pin still armed? If the pin was released, the observer
          // firing would do nothing — that is a different bug from "not firing".
          pinArmed: window.__e2ePinProbe ? window.__e2ePinProbe() : "no-probe",
          ua: navigator.userAgent,
        });
      }, 1500);
    });
  })()`);
  console.log("  [diag] " + JSON.stringify(diag));
  const scrollLog = await page.evaluate(`(() => window.__e2eScrollLog || [])()`);
  console.log("  [diag] scroll events: " + JSON.stringify(scrollLog));
}
check(
  "still pinned to the bottom after late growth",
  !!settled && settled.dist < 5,
  `dist=${settled?.dist}px (a missing ResizeObserver leaves this > 0)`
);
await page.evaluate(`(() => { document.getElementById('__e2e_growth')?.remove(); })()`);
await page.waitForTimeout(500);

// ------------------------------------- chat scroll: reading history is respected
console.log("\n4. Scrolling up to read history is not stolen");
await page.evaluate(`(() => {
  const chat = document.querySelector('[class*="bguru-chat-view"]');
  const vp = chat.querySelector('.mantine-ScrollArea-viewport');
  vp.scrollTop = 0;
  vp.dispatchEvent(new Event('scroll', { bubbles: true }));
})()`);
await page.waitForTimeout(4000);
d = await page.evaluate(CHAT_DIST);
check("position held while scrolled up", !!d && d.scrollTop < 50, `scrollTop=${d?.scrollTop}`);

// ------------------------------------------- chat scroll: re-open resets to bottom
console.log("\n5. Re-opening the tab resets to the bottom");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollBy(0, 4000));
await page.waitForTimeout(800);
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(4000);
d = await page.evaluate(CHAT_DIST);
check("re-open lands at the bottom", !!d && d.dist < 5, `dist=${d?.dist}px`);

// ------------------------------------------------- chat view survives search
console.log("\n6. Chat body survives opening search (2026-09-22 fix)");
const chatHeightBefore = await page.evaluate(`(() => {
  const c = document.querySelector('[class*="bguru-chat-view"]');
  return c ? Math.round(c.getBoundingClientRect().height) : 0;
})()`);
check("chat body has height", chatHeightBefore > 200, `${chatHeightBefore}px`);

// ------------------------------------------------- tab bar does not move
console.log("\n6b. Tab bar stays put when switching (drikin 2026-09-23)");
// The tabs are position:sticky, so ANY window scroll shifts them (80px at
// scrollY=0, 56px once scrolled). The bug was that opening the chat scrolled
// the window, so the bar jumped on every switch. Compare like with like: start
// from the top of the timeline, which is the state a user is in when they tap
// the chat tab without having scrolled.
const tabPos = async () =>
  page.evaluate(`(() => {
    const t = document.querySelector('[data-cx="navtabs"]');
    return t ? { top: Math.round(t.getBoundingClientRect().top), scrollY: Math.round(window.scrollY) } : null;
  })()`);

await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const tabOnTimeline = await tabPos();
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(3000);
const tabOnChat = await tabPos();

check("tab bar found on both views", tabOnTimeline !== null && tabOnChat !== null);
if (tabOnTimeline && tabOnChat) {
  check(
    "tab bar does not move between views",
    tabOnTimeline.top === tabOnChat.top,
    `timeline=${tabOnTimeline.top}px chat=${tabOnChat.top}px`
  );
  check(
    "window is not scrolled in chat view",
    tabOnChat.scrollY === 0,
    `scrollY=${tabOnChat.scrollY}`
  );
}

// 6c. The reported precondition: scrolled deep in the timeline, then switch.
// The chat must still open with the tab bar at its resting position.
console.log("\n6c. Switching from a scrolled timeline does not shift the bar");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 6000));
await page.waitForTimeout(1000);
await page.evaluate(clickTab("チャット"));
await page.waitForTimeout(3000);
const tabFromScrolled = await tabPos();
if (tabFromScrolled) {
  check(
    "tab bar is at its resting position after switching from a scrolled timeline",
    tabFromScrolled.top === tabOnTimeline?.top,
    `expected=${tabOnTimeline?.top}px got=${tabFromScrolled.top}px`
  );
}

// 6d. The bar must not move WHILE the timeline scrolls (drikin 2026-09-23:
// 「タイムラインがスクロールすると、タブの位置が若干ずれる」). With the sticky
// offset set to the header height the bar rested at 80px but snapped to 56px on
// the first scroll — a 24px jump that made every tab switch look jittery.
console.log("\n6d. Tab bar is pinned while the timeline scrolls");
await page.evaluate(clickTab("タイムライン"));
await page.waitForTimeout(2000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const tabAtTop = await tabPos();
const tabWhileScrolling = [];
for (const y of [50, 200, 800, 2500, 6000]) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(350);
  tabWhileScrolling.push(await tabPos());
}
const tops = tabWhileScrolling.map((t) => t?.top);
const allSame = tops.every((t) => t === tabAtTop?.top);
check(
  "tab bar does not move while scrolling the timeline",
  allSame,
  `at top=${tabAtTop?.top}px, while scrolling=${tops.join("/")}px`
);

// 6e. The bar must sit FLUSH against the header. Pinning it lower (80px) left a
// 24px strip above it where scrolled content showed through, which looks broken
// (drikin: 「スクロールしたコンテンツがタブの裏側に見えて変」).
console.log("\n6e. Tab bar sits flush under the header (no gap)");
await page.evaluate(() => window.scrollTo(0, 3000));
await page.waitForTimeout(600);
const gapInfo = await page.evaluate(`(() => {
  const t = document.querySelector('[data-cx="navtabs"]');
  const header = document.querySelector('[data-cx="header"]') || document.querySelector('header');
  if (!t) return null;
  const tr = t.getBoundingClientRect();
  const hr = header ? header.getBoundingClientRect() : null;
  return {
    tabTop: Math.round(tr.top),
    headerBottom: hr ? Math.round(hr.bottom) : null,
    gap: hr ? Math.round(tr.top - hr.bottom) : null,
  };
})()`);
check(
  "no gap between the header and the tab bar",
  !!gapInfo && gapInfo.gap !== null && Math.abs(gapInfo.gap) <= 1,
  gapInfo ? `header bottom=${gapInfo.headerBottom}px tab top=${gapInfo.tabTop}px gap=${gapInfo.gap}px` : "not found"
);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);

// ------------------------------------------------------------ image proxy
console.log("\n7. Images and avatars go through our own origin");
const imgStats = await page.evaluate(`(() => {
  const imgs = [...document.querySelectorAll('img')];
  const broken = imgs.filter(i => i.complete && i.naturalWidth === 0);
  return {
    total: imgs.length,
    gravatarDirect: imgs.filter(i => /gravatar\\.com/.test(i.src)).length,
    proxied: imgs.filter(i => /\\/api\\/(avatar|img)/.test(i.src)).length,
    broken: broken.length,
    brokenSrcs: broken.slice(0, 12).map(i => (i.currentSrc || i.src || "").slice(0, 130)),
  };
})()`);
check("no direct gravatar.com requests", imgStats.gravatarDirect === 0, `${imgStats.gravatarDirect} found`);
check("no broken images", imgStats.broken === 0, `${imgStats.broken} broken`);
if (imgStats.broken > 0) console.log("  [diag] broken srcs: " + JSON.stringify(imgStats.brokenSrcs, null, 1));
check("images are proxied", imgStats.proxied > 0, `${imgStats.proxied}/${imgStats.total}`);
if (notFound.length) {
  console.log(`  [info] ${notFound.length} avatar 404(s) — members without a Gravatar, expected`);
}

// ------------------------------------------------------------ final
check("no uncaught page errors at the end", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

console.log(`\n=== ${results.length - failed}/${results.length} passed ===\n`);
if (failed > 0) {
  console.log("FAILED:");
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  console.log("");
  process.exit(1);
}
process.exit(0);
