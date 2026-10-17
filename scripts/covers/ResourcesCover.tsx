import { CoverLayout } from "./components/CoverLayout.tsx";
import { Dot } from "./components/Dot.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-resources",
  packageName: "@luxass/pi-resources",
  title: "pi-resources",
  description: "Browse the resources Pi actually loaded.",
};

const tabs = ["Tools", "Context", "Skills", "Extensions", "Diagnostics"];

export function ResourcesCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 22 }}>
        <Text value="/resources" size={15} fill={accent} />
        <Panel style={{ padding: "22px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div
              style={{
                display: "flex",
                gap: 20,
                borderBottom: `1px solid ${border}`,
                paddingBottom: 16,
              }}
            >
              {tabs.map((tab) => (
                <Text key={tab} value={tab} size={15} fill={tab === "Tools" ? accent : muted} />
              ))}
            </div>
            {["read", "bash", "edit"].map((tool) => (
              <div key={tool} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Dot color={accent} />
                <Text value={tool} size={19} />
                <Text value="active · direct" size={14} fill={muted} />
              </div>
            ))}
          </div>
        </Panel>
        <Text
          value="Loaded context · Skills · Extension sources · Loader diagnostics"
          size={14}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
