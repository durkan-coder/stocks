import { ImageResponse } from "next/og";

// App icon, generated at runtime (no binary file to push): navy
// background, rising green bars, "SPY" in white. Used for the
// manifest icon (512) and the browser favicon.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: "22%",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: 18 }}>
          <div style={{ width: 44, height: 90, background: "#22c55e", borderRadius: 10 }} />
          <div style={{ width: 44, height: 140, background: "#22c55e", borderRadius: 10 }} />
          <div style={{ width: 44, height: 200, background: "#4ade80", borderRadius: 10 }} />
        </div>
        <div style={{ fontSize: 96, fontWeight: 800, color: "#ffffff", marginTop: 28, fontFamily: "sans-serif" }}>
          SPY
        </div>
      </div>
    ),
    { ...size },
  );
}
