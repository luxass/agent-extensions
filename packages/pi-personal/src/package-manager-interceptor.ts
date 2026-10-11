import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Catch common dependency-install commands, including those after `cd ... &&`.
// Keep the command intact: rewriting shell pipelines can change their meaning.
const INSTALL =
  /\b(?:pnpm\s+(?:install|add|i|dlx)|npm\s+(?:install|i|ci|exec)|bun\s+(?:install|add|i|x)|yarn\s+(?:install|add|dlx)|npx\b)(?=\s|$)/g;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    for (const match of command.matchAll(INSTALL)) {
      if (/\bsfw\s+$/.test(command.slice(0, match.index))) continue;
      return {
        block: true,
        reason:
          "Package installs must run through Socket Firewall. Retry with sfw before the package manager (for example, sfw pnpm install).",
      };
    }
    return undefined;
  });
}
