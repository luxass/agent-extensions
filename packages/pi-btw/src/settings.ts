import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;
type BtwSettings = PiSettings & { btw?: { tools?: unknown } };

const SUPPORTED_TOOLS = {
  read: true,
  grep: true,
  find: true,
  ls: true,
  bash: true,
  powershell: true,
  edit: true,
  write: true,
};

export type BtwToolName = keyof typeof SUPPORTED_TOOLS;

export const DEFAULT_BTW_TOOLS: readonly BtwToolName[] = ["read", "grep", "find", "ls"];

function isBtwTool(value: unknown): value is BtwToolName {
  return typeof value === "string" && Object.hasOwn(SUPPORTED_TOOLS, value);
}

export function getBtwTools({ btw }: BtwSettings): BtwToolName[] {
  const tools = btw?.tools;
  if (tools != null && (!Array.isArray(tools) || !tools.every(isBtwTool))) {
    throw new Error(
      `Invalid BTW settings: btw.tools must be an array of: ${Object.keys(SUPPORTED_TOOLS).join(", ")}.`,
    );
  }

  return [...new Set(tools ?? DEFAULT_BTW_TOOLS)];
}
