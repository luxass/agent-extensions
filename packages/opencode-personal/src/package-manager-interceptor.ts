import { Plugin } from "@opencode/plugin";

// Match the Pi interceptor, including installs after `cd ... &&`.
// Deny unwrapped commands rather than rewriting shell pipelines.
const INSTALL =
  /\b(?:pnpm\s+(?:install|add|i|dlx)|npm\s+(?:install|i|ci|exec)|bun\s+(?:install|add|i|x)|yarn\s+(?:install|add|dlx)|npx\b)(?=\s|$)/g;

const BLOCK_MESSAGE =
  "Package installs must run through Socket Firewall. Retry with sfw before the package manager (for example, sfw pnpm install).";

export default Plugin.define({
  id: "package-manager-interceptor",
  async setup(ctx) {
    const guard = await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "shell") return;
      for (const command of event.resources) {
        for (const match of command.matchAll(INSTALL)) {
          if (/\bsfw\s+$/.test(command.slice(0, match.index))) continue;
          event.effect = "deny";
          event.message = BLOCK_MESSAGE;
          return;
        }
      }
    });
    return () => guard.dispose();
  },
});
