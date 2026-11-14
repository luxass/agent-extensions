import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { arr, compile, int, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";

const SUBAGENT_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const agentSchema = obj({
  name: opt(str({ pattern: SUBAGENT_NAME_PATTERN })),
  description: str({ minLength: 1 }),
  tools: opt(arr(str({ minLength: 1 }))),
  model: opt(str({ minLength: 1 })),
  thinking: opt(oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
  max_turns: opt(int({ minimum: 0 })),
  skills: opt(arr(str({ minLength: 1 }))),
});
const validateAgent = compile(agentSchema);

/** A validated agent type from a Markdown file (S3). */
export interface SubagentDefinition extends Static<typeof agentSchema> {
  name: string;
  body: string;
  file: string;
}

/** Tools an agent gets when its file leaves out `tools` (S4). */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "bash", "edit", "write"];

/** Task and type names: lowercase words joined by hyphens (S1, S3). */
export function isSubagentName(name: string): boolean {
  return new RegExp(SUBAGENT_NAME_PATTERN).test(name);
}

/** Agent coordination stays in the main session, so agents cannot use these tools (S4). */
export function isSubagentControlTool(name: string): boolean {
  return (
    name === "Agent" ||
    name.startsWith("Agent(") ||
    name === "get_subagent_result" ||
    name === "steer_subagent" ||
    name === "stop_subagent"
  );
}

/** Loads agent types in precedence order. Project folders load only when trusted (S3). */
export async function loadSubagentDefinitions(
  cwd: string,
  trusted: boolean,
  warn: (message: string) => void,
): Promise<Map<string, SubagentDefinition>> {
  const directories = [
    fileURLToPath(new URL("./agents/", import.meta.url)),
    join(homedir(), ".pi/agent/agents"),
    join(homedir(), ".agents/agents"),
    ...(trusted ? [join(cwd, ".agents/agents"), join(cwd, ".pi/agents")] : []),
  ];
  const definitions = new Map<string, SubagentDefinition>();
  for (const directory of directories) {
    let filenames: string[];
    try {
      filenames = (await readdir(directory)).filter((name) => name.endsWith(".md")).toSorted();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`Cannot read agent directory ${directory}: ${String(error)}`);
      }
      continue;
    }
    for (const filename of filenames) {
      const file = join(directory, filename);
      const definition = await readSubagentDefinition(file, warn);
      if (definition) definitions.set(definition.name, definition);
    }
  }
  return definitions;
}

async function readSubagentDefinition(
  file: string,
  warn: (message: string) => void,
): Promise<SubagentDefinition | undefined> {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter(await readFile(file, "utf8")));
  } catch (error) {
    warn(`Skipping agent ${file}: invalid frontmatter (${String(error)}).`);
    return undefined;
  }
  const fields: Record<string, unknown> = { ...frontmatter };
  fields.name ??= basename(file, ".md");
  // Accept "read, grep" as well as a YAML list, as other agent files do.
  for (const key of ["tools", "skills"]) {
    const value = fields[key];
    if (typeof value === "string") {
      fields[key] = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  const problems = validateAgent.errors(fields).map((error) => {
    const field = error.path.slice(1).split("/")[0] || "frontmatter";
    return `${field} (${error.message})`;
  });
  const valid = fields as Static<typeof agentSchema>;
  const control = Array.isArray(valid.tools) ? valid.tools.filter(isSubagentControlTool) : [];
  if (control.length)
    problems.push(`tools (agents cannot coordinate agents: ${control.join(", ")})`);
  if (problems.length) {
    warn(`Skipping agent ${file}: ${[...new Set(problems)].join(", ")}.`);
    return undefined;
  }
  return { ...valid, name: String(fields.name), body: body.trim(), file };
}
