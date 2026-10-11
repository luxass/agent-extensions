import { Plugin } from "@opencode/plugin";

/**
 * Git Interceptor (OpenCode port of the Pi extension).
 *
 * 1. Editor hang prevention: inject no-op git editor env vars into every
 *    shell invocation so git never spawns an interactive editor.
 * 2. Hook bypass prevention: deny shell commands containing `--no-verify`
 *    so the agent cannot circumvent git hooks. Fix hook failures or ask
 *    the human instead.
 */
const NO_VERIFY_RE = /--no-verify\b/;

const BLOCK_MESSAGE =
  "BLOCKED: --no-verify is not allowed. Git hooks exist for a reason. " +
  "Do not attempt to bypass them. Instead: fix the underlying issue that " +
  "is causing the hook to fail, or ask the user for help.";

export default Plugin.define({
  id: "git-interceptor",
  async setup(ctx) {
    const editor = await ctx.shell.hook("create.before", (event) => {
      event.env.GIT_EDITOR = "true";
      event.env.GIT_SEQUENCE_EDITOR = "true";
      event.env.GIT_MERGE_AUTOEDIT = "no";
    });

    try {
      const guard = await ctx.permission.hook("evaluate", (event) => {
        if (event.action !== "shell") return;
        if (!event.resources.some((resource) => NO_VERIFY_RE.test(resource))) return;
        event.effect = "deny";
        event.message = BLOCK_MESSAGE;
      });

      return async () => {
        try {
          await guard.dispose();
        } finally {
          await editor.dispose();
        }
      };
    } catch (error) {
      await editor.dispose();
      throw error;
    }
  },
});
