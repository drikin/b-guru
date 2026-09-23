import type { Metadata, Viewport } from "next";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "./globals.css";

// NOTE: next/font/google Noto_Sans_JP was removed deliberately. For Japanese it
// emits 124 unicode-range subsets (496 @font-face rules, 5.3MB of woff2) and the
// browser fetched 60+ of them on first load at 900-2,500ms each. The theme now
// prefers the platform's Japanese system font (Hiragino Sans on macOS/iOS,
// Yu Gothic UI on Windows), which renders with zero font requests.

export const metadata: Metadata = {
  title: "B-guru | backspace.fm",
  description: "backspace.fm 有料会員向け BSM (即日配信・アフターショー) サービス「B-guru」",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Disable viewport zoom/scale so iOS does NOT auto-zoom when focusing
// an input/textarea (font-size < 16px triggers an automatic page zoom).
// Reference: https://qiita.com/skwbr/items/b285cc312587c73a4812
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // ⚠️ viewport-fit=cover が無いと env(safe-area-inset-*) は常に 0 を返す。
  // これが無いと iOS のノッチ/ホームインジケータ回避（globals.css の
  // padding-bottom: env(safe-area-inset-bottom)）が実質無効になる。
  viewportFit: "cover",
};

// Green key color — works in both light and dark via Mantine's primaryShade.
const theme = createTheme({
  primaryColor: "green",
  primaryShade: { light: 6, dark: 4 },
  // System fonts first. Noto Sans JP is split into 124 unicode-range subsets
  // (496 @font-face rules) for Japanese, and the browser fetched 60+ of them on
  // first load at 900-2,500ms each — the single largest contributor to the
  // initial load. macOS/iOS ship Hiragino Sans, Windows ships Yu Gothic UI, so
  // Japanese text renders natively with zero font requests. Noto Sans JP stays
  // as the last resort for platforms without a Japanese system font.
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, 'Noto Sans JP', sans-serif",
  headings: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, 'Noto Sans JP', sans-serif",
  },
  defaultRadius: "md",
  colors: {
    brand: [
      "#f0fdf4", // 0
      "#dcfce7", // 1
      "#bbf7d0", // 2
      "#86efac", // 3
      "#4ade80", // 4
      "#22c55e", // 5
      "#16a34a", // 6
      "#15803d", // 7
      "#166534", // 8
      "#14532d", // 9
    ],
  },
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/*
         * Resource hints. Measured on 2026-09-23: every subresource started at
         * ~428ms because the browser could not begin fetching until the HTML
         * document arrived (TTFB 394ms = 32ms server + ~362ms network RTT to
         * the Tokyo VPS). preconnect opens the TCP+TLS connection to the API
         * origin while the document is still in flight, so the first XHR does
         * not pay a second handshake. dns-prefetch covers browsers that ignore
         * preconnect. Both are no-ops when the origin is already warm.
         */}
        <link rel="preconnect" href="https://bsm.backspace.fm" crossOrigin="" />
        <link rel="dns-prefetch" href="https://bsm.backspace.fm" />
        {/*
         * The two stylesheets are render-blocking. Preloading them lets the
         * browser start the download in parallel with the JS chunks instead of
         * discovering them after the HTML parse. Next.js emits the hashed
         * filenames at build time, so we cannot hardcode them here — instead we
         * rely on the fact that Next already emits <link rel="stylesheet"> in
         * <head> before the body, which is the earliest possible point.
         */}
      </head>
      <body className="min-h-full flex flex-col">
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
