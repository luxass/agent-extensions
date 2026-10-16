import { CoverLayout } from "./components/CoverLayout.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-questions",
  packageName: "@luxass/pi-questions",
  title: "pi-questions",
  description: "Concrete choices, custom answers, and notes before Pi moves on.",
};

export function QuestionsCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 20 }}>
        <Text value="pi › Which approach do you prefer?" size={16} fill={muted} />
        <Panel>
          <div
            style={{
              display: "flex",
              padding: "12px 22px",
              borderBottom: `1px solid ${border}`,
            }}
          >
            <Text value="[1. Approach] · 2. Scope · Review" size={13} fill={accent} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", padding: "18px 22px", gap: 16 }}>
            <Text value="How much do you want to change?" size={22} />
            <div style={{ display: "flex", gap: 28 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <Text value="> ( ) 1. Small change" size={17} fill={accent} />
                  <Text value="    Keep the implementation focused." size={13} fill={muted} />
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <Text value="  ( ) 2. Full feature" size={17} />
                  <Text value="    Include all planned behavior." size={13} fill={muted} />
                </div>
                <Text value="  Type something." size={15} fill={muted} />
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  width: 300,
                  paddingLeft: 22,
                  gap: 12,
                  borderLeft: `1px solid ${border}`,
                }}
              >
                <Text value="Preview · p opens full view" size={12} fill={muted} />
                <Text value="export const enabled = true;" size={14} fill={accent} />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", padding: "10px 22px", borderTop: `1px solid ${border}` }}>
            <Text
              value="tab tabs · ↑↓ move · enter choose · n note · esc cancel"
              size={11}
              fill={muted}
            />
          </div>
        </Panel>
        <Text
          value="Choose an option, write your own answer, or add a note."
          size={13}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
