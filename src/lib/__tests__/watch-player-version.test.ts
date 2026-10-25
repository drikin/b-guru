import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// nginx serves every .js for a year (max-age=31536000, immutable) while index.html is
// max-age=0: the player is loaded as player.js?v=<its hash>, so a changed player reaches
// browsers and Android's WebView at once. Change player.js → update the v= in index.html.
describe("watch player version", () => {
  it("index.html loads player.js with its current hash", () => {
    const dir = join(process.cwd(), "public", "watch");
    const hash = createHash("sha256").update(readFileSync(join(dir, "player.js"))).digest("hex").slice(0, 10);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain(`<script src="player.js?v=${hash}"></script>`);
  });
});
