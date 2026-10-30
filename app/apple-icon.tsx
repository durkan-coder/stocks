import { ImageResponse } from "next/og";

// Apple touch icon (180x180) for iOS "Add to Home Screen": same
// design as app/icon.tsx, generated at runtime so no binary file
// needs to be pushed to GitHub.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b1f3a",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: 7 }}>
          <div style={{ width: 16, height: 32, background: "#22c55e", borderRadius: 4 }} />
          <div style={{ width: 16, height: 50, background: "#22c55e", borderRadius: 4 }} />
          <div style={{ width: 16, height: 70, background: "#4ade80", borderRadius: 4 }} />
        </div>
        <div style={{ fontSize: 34, fontWeight: 800, color: "#ffffff", marginTop: 10, fontFamily: "sans-serif" }}>
          SPY
        </div>
      </div>
    ),
    { ...size },
  );
}
