import { CoverLayout } from "./components/CoverLayout.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-subagents",
  packageName: "@luxass/pi-subagents",
  title: "pi-subagents",
  description: "Hand tasks to named agents and read their work while you keep going.",
};

export function SubagentsCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 20 }}>
        <Text value="you › @explorer review authentication" size={16} fill={muted} />
        <Panel>
          <div
            style={{ display: "flex", padding: "12px 22px", borderBottom: `1px solid ${border}` }}
          >
            <Text value="Agents · auth-review · explorer · completed" size={13} fill={accent} />
          </div>
          <div style={{ display: "flex", padding: "16px 22px", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
              <Text value="› auth-review    done" size={17} fill={accent} />
              <Text value="  parser-review  running" size={17} />
              <Text value="  docs-check     queued" size={17} fill={muted} />
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 560,
                gap: 10,
                paddingLeft: 22,
                borderLeft: `1px solid ${border}`,
              }}
            >
              <Text value="read src/auth/session.ts" size={14} fill={muted} />
              <Text value="Logout keeps the refresh token." size={18} />
              <Text value="8 turns · 11 tool uses · 42s" size={13} fill={muted} />
            </div>
          </div>
          <div style={{ display: "flex", padding: "10px 22px", borderTop: `1px solid ${border}` }}>
            <Text
              value="↑↓ select · enter read · x stop · f fullscreen · esc close"
              size={11}
              fill={muted}
            />
          </div>
        </Panel>
        <Text value="Results come back to the chat by themselves." size={13} fill={muted} />
      </div>
    </CoverLayout>
  );
}
