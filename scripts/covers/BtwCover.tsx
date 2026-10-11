import { CoverLayout } from "./components/CoverLayout.tsx";
import { Cursor } from "./components/Cursor.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-btw",
  packageName: "@luxass/pi-btw",
  title: "pi-btw",
  description: "A quick detour, not a new task. Ask in context, then pick up where you left off.",
};

export function BtwCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Text value="you › Prepare the next release." size={16} fill={muted} opacity={0.8} />
          <Text
            value="pi  › Checking the changes since v1.3…"
            size={16}
            fill={muted}
            opacity={0.8}
          />
        </div>
        <Panel>
          <div style={{ display: "flex", flexDirection: "column", padding: "16px 22px", gap: 20 }}>
            <Text value="btw · a question along the way" size={12} fill={accent} />
            <Text value="› What belongs in a release note?" size={22} />
            <div style={{ display: "flex", flexDirection: "column", paddingLeft: 20 }}>
              <Text
                value="Describe what changed for the person using the package."
                size={19}
                fill={muted}
              />
              <Text
                value="Include migration steps and any new requirements."
                size={19}
                fill={muted}
              />
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 22px",
              gap: 8,
              borderTop: `1px solid ${border}`,
            }}
          >
            <Text value="›" fill={accent} />
            <Cursor color={accent} />
          </div>
          <div style={{ display: "flex", padding: "0 22px 10px" }}>
            <Text value="enter ask · esc close · ↑↓ scroll" size={11} fill={muted} />
          </div>
        </Panel>
        <Text
          value="Leave this conversation here, or bring a summary back to the main chat."
          size={12}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
