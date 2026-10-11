import { CoverLayout } from "./components/CoverLayout.tsx";
import { Dot } from "./components/Dot.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-personal",
  packageName: "@luxass/pi-personal",
  title: "pi-personal",
  description: "Small touches tuned to one workflow, collected in a single package.",
};

const notices = [
  "Personal extension activated.",
  "Layout restored from the last session.",
  "Tools pinned: read · grep · bash",
];

export function PersonalCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 22 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Text value="/personal" size={13} fill={accent} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Dot color={accent} />
            <Text value="session_start → notifications" size={15} fill={muted} opacity={0.8} />
          </div>
        </div>
        <Panel style={{ padding: "4px 22px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {notices.map((notice, index) => (
              <div
                key={notice}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 13,
                  padding: "16px 0",
                  borderTop: index === 0 ? "none" : `1px solid ${border}`,
                }}
              >
                <Dot color={accent} />
                <Text value={notice} size={17} />
              </div>
            ))}
          </div>
        </Panel>
        <Text
          value="Personal defaults live here. Rewrite them as the workflow changes."
          size={13}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
