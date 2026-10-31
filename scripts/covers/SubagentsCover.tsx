import { CoverLayout } from "./components/CoverLayout.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-subagents",
  packageName: "@luxass/pi-subagents",
  title: "pi-subagents",
  description: "Focused agents. Live progress. One conversation.",
};

export function SubagentsCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 16 }}>
        <Text value="pi › Explore the code while I work on the change." size={16} fill={muted} />
        <Panel style={{ width: 1064 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 22px" }}>
            <div style={{ display: "flex", gap: 24 }}>
              <Text value="> Explore · Find authentication entry points" size={16} fill={accent} />
              <Text value="running" size={13} fill={accent} />
            </div>
            <Text value="   4 tools · 2 turns · 12.4k tokens · 8s" size={14} fill={muted} />
            <Text value="   ↳ reading src/auth/session.ts · background" size={15} />
            <Text
              value="   @auth-map · completion will arrive automatically"
              size={13}
              fill={muted}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "16px 22px",
              borderTop: `1px solid ${border}`,
            }}
          >
            <Text value="✓ Plan · Outline the migration" size={16} fill={accent} />
            <Text value="   3 tools · 3 turns · 9.1k tokens · 14s" size={14} fill={muted} />
            <Text value="   └ Start with the session boundary, then update callers." size={15} />
          </div>
          <div style={{ display: "flex", padding: "12px 26px", borderTop: `1px solid ${border}` }}>
            <Text
              value="Fleet · main │ auth-map:running │ migration:completed"
              size={13}
              fill={muted}
            />
          </div>
        </Panel>
        <Text
          value="Inspect conversations. Steer a run. Resume where it stopped."
          size={14}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
