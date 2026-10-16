/* Native app downloads (B-guru Chat for Mac beta, and the Android APK).
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
  /** CFBundleVersion — what Sparkle compares (monotonic build number). */
  build: string;
  /** Sparkle EdDSA signature of the DMG (sign_update). Without it no update is offered. */
  edSignature: string;
  /** Short release notes shown in the update dialog (plain text). */
  notes: string;
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
  const build = typeof m.build === "string" && /^\d{1,20}$/.test(m.build) ? m.build : "";
  const edSignature =
    typeof m.edSignature === "string" && /^[A-Za-z0-9+/]{40,200}={0,2}$/.test(m.edSignature) ? m.edSignature : "";
  return {
    version,
    build,
    edSignature,
    notes: typeof m.notes === "string" ? m.notes.slice(0, 2000) : "",
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

const xmlEscape = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Sparkle appcast for the current release. An item is offered only when the
 * manifest carries a build number AND an EdDSA signature — Sparkle refuses
 * unsigned updates anyway, and an item without them would only show an error.
 */
export function buildAppcast(rel: MacRelease | null, origin: string): string {
  const item =
    rel && rel.build && rel.edSignature
      ? `
    <item>
      <title>${xmlEscape(`B-guru Chat ${rel.version}`)}</title>
      <pubDate>${new Date(rel.publishedAt || Date.now()).toUTCString()}</pubDate>
      <sparkle:version>${rel.build}</sparkle:version>
      <sparkle:shortVersionString>${xmlEscape(rel.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${xmlEscape(rel.minimumSystemVersion)}</sparkle:minimumSystemVersion>${
        rel.notes ? `\n      <description>${xmlEscape(rel.notes).replace(/\n/g, "&lt;br&gt;")}</description>` : ""
      }
      <enclosure url="${xmlEscape(`${origin}/api/download/mac?v=${rel.version}`)}" length="${rel.size}" type="application/octet-stream" sparkle:edSignature="${rel.edSignature}"/>
    </item>`
      : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>B-guru Chat for Mac</title>${item}
  </channel>
</rss>
`;
}

/* ---- Android (APK, sideloaded) ----
 * `android.json`, written by native/android/scripts/publish.sh:
 *   { "version": "0.1.0", "versionCode": 3, "file": "BguruChat-0.1.0.apk", "size": …,
 *     "sha256": "…", "certSha256": "…", "minSdk": 28, "notes": "…", "publishedAt": "…" }
 * certSha256 is the signing certificate's fingerprint, shown so members can check
 * that an APK really came from us (and every update must keep the same key). */
export interface AndroidRelease {
  version: string;
  versionCode: number;
  file: string;
  size: number;
  sha256: string;
  certSha256: string;
  minSdk: number;
  notes: string;
  publishedAt: string;
}

const APK_RE = /^BguruChat-\d+\.\d+\.\d+\.apk$/;

export function parseAndroidManifest(raw: unknown): AndroidRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const file = typeof m.file === "string" ? m.file : "";
  const version = typeof m.version === "string" ? m.version : "";
  const versionCode = typeof m.versionCode === "number" && Number.isInteger(m.versionCode) && m.versionCode > 0 ? m.versionCode : 0;
  if (!APK_RE.test(file) || !VERSION_RE.test(version) || !versionCode) return null; // also blocks path traversal
  return {
    version,
    versionCode,
    file,
    size: typeof m.size === "number" && m.size > 0 ? m.size : 0,
    sha256: typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : "",
    certSha256: typeof m.certSha256 === "string" && /^[0-9A-F:]{64,95}$/i.test(m.certSha256) ? m.certSha256 : "",
    minSdk: typeof m.minSdk === "number" ? m.minSdk : 28,
    notes: typeof m.notes === "string" ? m.notes.slice(0, 2000) : "",
    publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : "",
  };
}

/** Current Android release, or null when none is published / the file is missing. */
export async function getAndroidRelease(): Promise<(AndroidRelease & { path: string }) | null> {
  try {
    const raw = JSON.parse(await readFile(/*turbopackIgnore: true*/ path.join(DOWNLOADS_DIR, "android.json"), "utf8"));
    const rel = parseAndroidManifest(raw);
    if (!rel) return null;
    const p = path.join(/*turbopackIgnore: true*/ DOWNLOADS_DIR, rel.file);
    const s = await stat(/*turbopackIgnore: true*/ p);
    if (!s.isFile()) return null;
    return { ...rel, size: s.size, path: p };
  } catch {
    return null;
  }
}
