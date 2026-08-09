import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "B-guru | backspace.fm",
    short_name: "B-guru",
    description: "backspace.fm 有料会員向け BSM (即日配信・アフターショー) サービス「B-guru」",
    start_url: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#16a34a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}