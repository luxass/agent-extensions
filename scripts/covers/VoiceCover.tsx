import { CoverLayout } from "./components/CoverLayout.tsx";
import { Cursor } from "./components/Cursor.tsx";
import { Dot } from "./components/Dot.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { Waveform } from "./components/Waveform.tsx";
import { accent, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-voice",
  packageName: "@luxass/pi-voice",
  title: "pi-voice",
  description: "Dictate a draft. Tidy it up in Pi. Send it when you're ready.",
};

export const opencodeMetadata = {
  directory: "opencode-voice",
  packageName: "@luxass/opencode-voice",
  title: "opencode-voice",
  description: "Dictate a draft. Paste it into OpenCode. Send it when you are ready.",
};

export function VoiceCover({ host = "pi" }: { host?: "pi" | "opencode" }) {
  const isOpenCode = host === "opencode";
  const heights = [
    6, 12, 18, 32, 24, 48, 68, 92, 59, 34, 19, 39, 78, 110, 74, 45, 24, 17, 28, 48, 33, 16, 8, 5, 3,
    3, 3, 3,
  ];
  return (
    <CoverLayout {...(isOpenCode ? opencodeMetadata : metadata)}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 20 }}>
        <Text value="/voice" size={13} fill={accent} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Dot color={accent} />
          <Text value="capture an idea → turn it into text" size={15} fill={muted} />
        </div>
        <Waveform heights={heights} color={accent} />
        <Panel style={{ padding: "16px 22px", gap: 16 }}>
          <Text value={isOpenCode ? "CLIPBOARD" : "COMPOSER"} size={11} fill={muted} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Text value="Move the search above the filters, and keep" size={21} />
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <Text value="my selected filters visible while scrolling." size={21} />
              <Cursor color={accent} height={20} />
            </div>
          </div>
          <Text
            value={
              isOpenCode
                ? "Draft copied. Paste it into the composer."
                : "Draft inserted. Make it yours."
            }
            size={12}
            fill={accent}
          />
        </Panel>
        <Text
          value="Change a word, add a detail, then press send yourself."
          size={12}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
