/**
 * Git Interceptor
 *
 * Guards for agent-driven git commands:
 *
 * 1. Editor hang prevention — Sets GIT_EDITOR, GIT_SEQUENCE_EDITOR to `true`
 *    (no-op) and GIT_MERGE_AUTOEDIT to `no` so git never spawns an interactive
 *    editor (nvim, vim, etc.) that would hang the bash process.
 *
 * 2. Hook bypass prevention — Blocks any command containing `--no-verify` so
 *    the agent cannot circumvent git hooks (pre-commit, commit-msg, etc.).
 *    The agent should fix hook failures or ask the human for help instead.
 *
 * 3. Signing bypass prevention — Preserve the user's signing settings and
 *    block common attempts to disable them. Never force signing on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const GIT_ENV_PREFIX = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

const NO_VERIFY_RE = /--no-verify\b/;

const BLOCK_REASON =
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

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.git_signing_policy = SIGNING_POLICY;
  });

  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    if (disablesSigning(event.input.command)) {
      return { block: true, reason: SIGNING_BLOCK_REASON };
    }
    if (!/\bgit\b/i.test(event.input.command)) return undefined;

    if (NO_VERIFY_RE.test(event.input.command)) {
      return { block: true, reason: BLOCK_REASON };
    }

    event.input.command = GIT_ENV_PREFIX + event.input.command;
    return undefined;
  });
}
