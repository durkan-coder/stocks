export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1f3a" };

export const metadata = {
  title: "SPY Scanner Leaderboard",
  description: "S&P 500 stocks screened every 15 minutes for a potential 5%+ rise within 1 week.",
  appleWebApp: { capable: true, title: "SPY Scanner", statusBarStyle: "black-translucent" as const },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
