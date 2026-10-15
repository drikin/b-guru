/* Native app downloads (B-guru Chat for Mac beta).
 *
 * The signed + notarized DMG lives OUTSIDE the repo on the server, in
 * DOWNLOADS_DIR (default /home/ubuntu/bsm-downloads), next to a small manifest
 * `mac.json` written by native/mac/scripts/publish.sh:
 *   { "version": "0.1.2", "file": "BguruChat-0.1.2.dmg", "size": 2034567,
 *     "sha256": "…", "minimumSystemVersion": "14.0", "publishedAt": "…" }
 * Keeping binaries out of git means a new beta is a copy, not a deploy. */
import { readFile, stat } from "fs/promises";
import path from "path";

export const DOWNLOADS_DIR = process.env.BGURU_DOWNLOADS_DIR || "/home/ubuntu/bsm-downloads";

export interface MacRelease {
  version: string;
  file: string;
  size: number;
  sha256: string;
  minimumSystemVersion: string;
  publishedAt: string;
}

const FILE_RE = /^BguruChat-\d+\.\d+\.\d+\.dmg$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Parse + validate the manifest. Anything unexpected → null (no download offered). */
export function parseMacManifest(raw: unknown): MacRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const file = typeof m.file === "string" ? m.file : "";
  const version = typeof m.version === "string" ? m.version : "";
  if (!FILE_RE.test(file) || !VERSION_RE.test(version)) return null; // also blocks path traversal
  return {
    version,
    file,
    size: typeof m.size === "number" && m.size > 0 ? m.size : 0,
    sha256: typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : "",
    minimumSystemVersion: typeof m.minimumSystemVersion === "string" ? m.minimumSystemVersion : "14.0",
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : "",
  };
}

/** Current Mac release, or null when none is published / the file is missing. */
export async function getMacRelease(): Promise<(MacRelease & { path: string }) | null> {
  try {
    // turbopackIgnore: a runtime directory outside the project — don't trace it into the build.
    const raw = JSON.parse(await readFile(/*turbopackIgnore: true*/ path.join(DOWNLOADS_DIR, "mac.json"), "utf8"));
    const rel = parseMacManifest(raw);
    if (!rel) return null;
    const p = path.join(/*turbopackIgnore: true*/ DOWNLOADS_DIR, rel.file);
    const s = await stat(/*turbopackIgnore: true*/ p);
    if (!s.isFile()) return null;
    return { ...rel, size: s.size, path: p };
  } catch {
    return null;
  }
}
