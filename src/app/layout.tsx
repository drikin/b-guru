import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP } from "next/font/google";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "./globals.css";

// Japanese-optimized font (self-hosted subset via next/font)
const notoSansJp = Noto_Sans_JP({
  variable: "--font-noto-sans-jp",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

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
};

// Green key color — works in both light and dark via Mantine's primaryShade.
const theme = createTheme({
  primaryColor: "green",
  primaryShade: { light: 6, dark: 4 },
  fontFamily:
    "var(--font-noto-sans-jp), -apple-system, BlinkMacSystemFont, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
  headings: {
    fontFamily:
      "var(--font-noto-sans-jp), -apple-system, BlinkMacSystemFont, sans-serif",
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
    <html lang="ja" className={`${notoSansJp.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
