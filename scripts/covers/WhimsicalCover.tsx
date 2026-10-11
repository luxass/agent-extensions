import { CodeLines } from "./components/CodeLines.tsx";
import { CoverLayout } from "./components/CoverLayout.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-whimsical",
  packageName: "@luxass/pi-whimsical",
  title: "pi-whimsical",
  description: "Pi has work to do. Its status messages have other ideas.",
};

export function WhimsicalCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 24 }}>
        <Text value="you › Make the settings page work on mobile." size={17} fill={muted} />
        <div style={{ display: "flex", flexDirection: "column", gap: 16, opacity: 0.8 }}>
          <Text value="read  src/pages/settings.tsx" size={14} fill={muted} />
          <CodeLines widths={[438, 326, 382]} />
          <Text value="bash  pnpm lint" size={14} fill={muted} />
          <CodeLines widths={[291, 421]} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 15,
            borderTop: `1px solid ${border}`,
            paddingTop: 26,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle
              cx="7"
              cy="7"
              r="6"
              fill="none"
              stroke={accent}
              strokeWidth="1.5"
              strokeDasharray="22 16"
            />
          </svg>
          <Text value="Convincing the pixels to cooperate..." size={24} fill={accent} />
        </div>
        <Text
          value="Other moods: Summoning semicolons... · Negotiating with entropy..."
          size={13}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
