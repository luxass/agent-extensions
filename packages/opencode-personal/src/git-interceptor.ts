import { Plugin } from "@opencode/plugin";

/**
 * Git Interceptor (OpenCode port of the Pi extension).
 *
 * Preserve signing settings, block hook/signing bypasses, and prevent editor hangs.
 * Shell checks cover common command forms, not arbitrary shell programs.
 */
const NO_VERIFY_RE = /--no-verify\b/;

const BLOCK_MESSAGE =
  "BLOCKED: --no-verify is not allowed. Git hooks exist for a reason. " +
  "Do not attempt to bypass them. Instead: fix the underlying issue that " +
  "is causing the hook to fail, or ask the user for help.";

const SIGNING_POLICY = `Git signing policy:
Preserve the user's configured commit signing behavior for commits and rebases.
Never disable or bypass signing with --no-gpg-sign, commit.gpgsign=false, false boolean equivalents, configuration removal, or environment overrides.
Do not change signing keys, signing programs, or signing configuration to work around a failure.
If signing fails, stop and ask the user for help. Do not retry with signing disabled.
Do not force signing in repositories where the user has not enabled it.`;

const SIGNING_BLOCK_REASON =
  "BLOCKED: Disabling Git commit signing is not allowed. Preserve the user's signing settings. " +
  "If signing fails, stop and ask the user for help instead of retrying without signing.";

function disablesSigning(command: string): boolean {
  // Match common quoted shell forms without claiming to parse arbitrary shell code.
  const normalized = command.replace(/["'\\]/g, "").toLowerCase();
  if (/--no-gpg-sign\b/.test(normalized)) return true;
  if (/\bcommit\.gpgsign\s*(?:=\s*|\s+)(?:false|no|off|0)(?=$|[\s;|&()])/.test(normalized)) {
    return true;
  }
  if (
    /\bcommit\.gpgsign\b/.test(normalized) &&
    /(?:^|\s)(?:--unset(?:-all)?|unset)(?=\s|$)/.test(normalized)
  ) {
    return true;
  }
  for (const match of normalized.matchAll(/\bgit_config_key_(\d+)=commit\.gpgsign\b/g)) {
    const value = new RegExp(`\\bgit_config_value_${match[1]}=(?:false|no|off|0)(?=$|[\\s;|&()])`);
    if (value.test(normalized)) return true;
  }
  return false;
}

export default Plugin.define({
  id: "git-interceptor",
  async setup(ctx) {
    const editor = await ctx.shell.hook("create.before", (event) => {
      event.env.GIT_EDITOR = "true";
      event.env.GIT_SEQUENCE_EDITOR = "true";
      event.env.GIT_MERGE_AUTOEDIT = "no";
    });
    let disposePolicy: (() => Promise<void>) | undefined;
    const cleanup = async () => {
      try {
        await disposePolicy?.();
      } finally {
        await editor.dispose();
      }
    };

    try {
      const policy = await ctx.session.hook("context", (event) => {
        if (event.system.some((part) => part.text === SIGNING_POLICY)) return;
        event.system.push({ type: "text", text: SIGNING_POLICY });
      });
      disposePolicy = () => policy.dispose();

      const guard = await ctx.permission.hook("evaluate", (event) => {
        if (event.action !== "shell") return;
        const reason = event.resources.some((resource) => disablesSigning(resource))
          ? SIGNING_BLOCK_REASON
          : event.resources.some((resource) => NO_VERIFY_RE.test(resource))
            ? BLOCK_MESSAGE
            : undefined;
        if (!reason) return;
        event.effect = "deny";
        event.message = reason;
      });

      return async () => {
        try {
          await guard.dispose();
        } finally {
          await cleanup();
        }
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  },
});
