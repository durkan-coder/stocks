import type { MetadataRoute } from "next";

// Home-screen app manifest: lets iOS "Add to Home Screen" install the
// dashboard as a standalone app with our own icon, instead of a
// generic Safari bookmark. No native code, no App Store — the app
// still loads the live Vercel site, so scans, trades and cron are
// unchanged.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SPY Scanner",
    short_name: "SPY Scanner",
    description: "S&P 500 stocks screened every 15 minutes for a potential 5%+ rise within 1 week.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b1f3a",
    theme_color: "#0b1f3a",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
