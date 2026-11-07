import { CoverLayout } from "./components/CoverLayout.tsx";
import { Panel } from "./components/Panel.tsx";
import { Text } from "./components/Text.tsx";
import { accent, border, muted } from "./theme.ts";

export const metadata = {
  directory: "pi-cost-explorer",
  packageName: "@luxass/pi-cost-explorer",
  title: "pi-cost-explorer",
  description: "See where a session spent its money, prompt by prompt.",
};

const tabs = ["Overview", "Models", "Turns", "Tools", "Requests"];

const turns = [
  { prompt: "Refactor the session loader", cost: "$0.412", share: 1 },
  { prompt: "Add a cache warmer", cost: "$0.268", share: 0.65 },
  { prompt: "Fix the flaky resize bug", cost: "$0.131", share: 0.32 },
];

export function CostExplorerCover() {
  return (
    <CoverLayout {...metadata}>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 36px", gap: 22 }}>
        <Text value="/cost" size={15} fill={accent} />
        <Panel style={{ padding: "22px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div
              style={{
                display: "flex",
                gap: 20,
                borderBottom: `1px solid ${border}`,
                paddingBottom: 16,
              }}
            >
              {tabs.map((tab) => (
                <Text key={tab} value={tab} size={15} fill={tab === "Turns" ? accent : muted} />
              ))}
            </div>
            {turns.map((turn) => (
              <div key={turn.prompt} style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ display: "flex", width: 340 }}>
                  <Text value={turn.prompt} size={18} />
                </div>
                <div style={{ display: "flex", width: 80, justifyContent: "flex-end" }}>
                  <Text value={turn.cost} size={18} fill={accent} />
                </div>
                <div
                  style={{
                    display: "flex",
                    width: 160 * turn.share,
                    height: 14,
                    backgroundColor: accent,
                    borderRadius: 3,
                  }}
                />
              </div>
            ))}
          </div>
        </Panel>
        <Text
          value="Totals · Cache hit rate · Cost by model, prompt, tool, and request"
          size={14}
          fill={muted}
        />
      </div>
    </CoverLayout>
  );
}
