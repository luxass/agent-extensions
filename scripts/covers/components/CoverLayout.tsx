import type { ReactNode } from "react";

import { accent, ink, muted, paper } from "../theme.ts";
import { Text } from "./Text.tsx";

export function CoverLayout({
  title,
  description,
  packageName,
  children,
}: {
  title: string;
  description: string;
  packageName: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 1280,
        height: 800,
        padding: "52px 72px",
        background: paper,
        color: ink,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="m6 1 5 5-5 5-5-5Z" fill="none" stroke={accent} strokeWidth="1.5" />
        </svg>
        <Text value="luxass.dev / agent extensions" size={12} fill={muted} />
      </div>
      <div
        style={{
          display: "flex",
          fontFamily: "DM Sans",
          fontSize: 74,
          fontWeight: 600,
          letterSpacing: -2,
          lineHeight: 1.2,
          marginTop: 24,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", marginTop: 16 }}>
        <Text value={description} size={18} fill={muted} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 48 }}>{children}</div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "auto",
        }}
      >
        <Text value={`npm:${packageName}`} size={14} fill={muted} />
        <Text value="ILLUSTRATIVE UI" size={10} fill={muted} />
      </div>
    </div>
  );
}
