import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  agentPrompt,
  builtins,
  defaults,
  parseAgent,
  serializeAgent,
  validateSettings,
  type AgentDefinition,
  type Settings,
} from "./agents.ts";
import {
  atomicWrite,
  checkedFile,
  contained,
  isMissing,
  readObject,
  readText,
  safeDestination,
  maxResourceBytes,
  safeName,
} from "./io.ts";

/** Thrown when a save would replace a different existing file and the caller did not allow it. */
export class OverwriteError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists.`);
  }
}

export interface SaveOptions {
  /** Replace an existing file at the destination that is not the definition's own file. */
  overwrite?: boolean;
}

export interface Catalog {
  settings: Settings;
  definitions(): readonly AgentDefinition[];
  /** The definition as loaded from its file, without settings such as disabledAgents. */
  stored(name: string): Readonly<AgentDefinition> | undefined;
  resolve(name: string): Readonly<AgentDefinition>;
  reload(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  toggle(name: string): Promise<void>;
  eject(name: string): Promise<string>;
  saveDefinition(definition: AgentDefinition, options?: SaveOptions): Promise<string>;
  prompt(definition: AgentDefinition): Promise<string>;
  warnings: readonly string[];
}

function key(name: string): string {
  return safeName(name).toLowerCase();
}

export async function createCatalog(ctx: ExtensionContext): Promise<Catalog> {
  const cwd = resolve(ctx.cwd);
  const agentDir = resolve(getAgentDir());
  const universalDir = join(homedir(), ".agents");
  const globalSettingsPath = join(agentDir, "subagents.json");
  const projectSettingsPath = join(cwd, ".pi", "subagents.json");
  let settings: Settings = { ...defaults, disabledAgents: [] };
  let definitions: readonly AgentDefinition[] = [];
  let lookup = new Map<string, AgentDefinition>();
  let intrinsic = new Map<string, AgentDefinition>();
  let skills = new Map<string, Skill>();
  let warnings: string[] = [];
  let previousWarnings = new Set<string>();
  // Serialize reloads and local mutations in this process.
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const warn = (message: string): void => {
    warnings.push(message);
  };

  async function settingsLayer(path: string): Promise<Partial<Settings>> {
    try {
      return validateSettings(await readObject(path));
    } catch (error) {
      warn(`${path}: ${String(error)} File left unchanged; repair or move it before saving.`);
      return {};
    }
  }

  /** Agent folders in load order. Later roots win; project .pi is more specific than project .agents. */
  function agentRoots(trusted: boolean): { dir: string; source: "project" | "user" }[] {
    return [
      { dir: universalDir, source: "user" },
      { dir: agentDir, source: "user" },
      ...(trusted
        ? [
            { dir: join(cwd, ".agents"), source: "project" as const },
            { dir: join(cwd, ".pi"), source: "project" as const },
          ]
        : []),
    ];
  }

  async function reload(): Promise<void> {
    warnings = [];
    const trusted = ctx.isProjectTrusted();
    const global = await settingsLayer(globalSettingsPath);
    const project = trusted ? await settingsLayer(projectSettingsPath) : {};
    const nextSettings: Settings = { ...defaults, disabledAgents: [], ...global, ...project };
    const next = new Map<string, AgentDefinition>();
    for (const definition of builtins()) next.set(key(definition.name), definition);
    const packaged = await packageResources(cwd, agentDir, trusted, nextSettings, warn);

    async function addAgent(
      resource: ResourceFile,
      source: AgentDefinition["source"],
    ): Promise<void> {
      try {
        const definition = parseAgent(
          await checkedFile(resource),
          resource.file,
          source,
          resource.packageName,
        );
        const id = key(definition.name);
        if (next.get(id)?.source === source)
          warn(
            `Agent ${definition.name}: ${resource.file} overrides ${next.get(id)?.file ?? "another definition"}.`,
          );
        next.set(id, definition);
      } catch (error) {
        warn(`${resource.file}: ${String(error)}`);
      }
    }

    for (const resource of packaged) await addAgent(resource, "package");
    const roots = agentRoots(trusted);
    for (const root of roots) {
      const agentRoot = join(root.dir, "agents");
      try {
        for (const file of await resourceFiles(agentRoot, [".md"], warn))
          await addAgent({ file, root: agentRoot }, root.source);
      } catch (error) {
        warn(`${agentRoot}: ${String(error)}`);
      }
    }
    const hostSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    for (const error of hostSettings.drainErrors()) warn(`Skill settings: ${error.error.message}`);
    const skillPaths: string[] = [];
    for (const root of roots) {
      const path = join(root.dir, "skills");
      try {
        if ((await stat(path)).isDirectory()) skillPaths.push(path);
        else warn(`Skill directory is not a directory: ${path}`);
      } catch (error) {
        if (!isMissing(error)) warn(`Skill directory ${path}: ${String(error)}`);
      }
    }
    for (const [base, paths] of [
      [agentDir, hostSettings.getGlobalSettings().skills ?? []],
      [join(cwd, ".pi"), trusted ? (hostSettings.getProjectSettings().skills ?? []) : []],
    ] as const) {
      for (const path of paths) {
        if (path.split(/[\\/]/).includes("..")) {
          warn(`Skill path traversal rejected: ${path}`);
          continue;
        }
        const expanded = path.startsWith("~/")
          ? join(homedir(), path.slice(2))
          : resolve(base, path);
        skillPaths.push(expanded);
      }
    }
    // The host keeps the first matching skill, so pass the most specific roots first.
    const loaded = loadSkills({
      cwd,
      agentDir,
      includeDefaults: false,
      skillPaths: skillPaths.toReversed(),
    });
    const nextSkills = new Map<string, Skill>();
    for (const skill of loaded.skills) {
      try {
        nextSkills.set(key(skill.name), skill);
      } catch (error) {
        warn(String(error));
      }
    }
    for (const diagnostic of loaded.diagnostics)
      warn(`Skill${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}`);
    const disabled = new Set(nextSettings.disabledAgents.map(key));
    const nextLookup = new Map<string, AgentDefinition>();
    for (const [id, definition] of next)
      nextLookup.set(id, { ...definition, enabled: definition.enabled && !disabled.has(id) });
    settings = nextSettings;
    intrinsic = next;
    lookup = nextLookup;
    definitions = [...lookup.values()].toSorted((a, b) =>
      key(a.name).localeCompare(key(b.name), "en"),
    );
    skills = nextSkills;
    // Reloads run on every Agent call, so report only warnings the previous load did not have.
    const fresh = warnings.filter((warning) => !previousWarnings.has(warning));
    previousWarnings = new Set(warnings);
    if (ctx.hasUI && fresh.length > 0) {
      const preview = fresh.slice(0, 8).join("\n");
      const remaining =
        fresh.length > 8 ? `\n${fresh.length - 8} more catalog warnings were recorded.` : "";
      ctx.ui.notify(`Subagent catalog:\n${preview}${remaining}`, "warning");
    }
  }

  async function persist(
    patch: Partial<Settings>,
    toggleName?: string,
    forceEnable = false,
  ): Promise<void> {
    const validated = validateSettings(patch);
    const path = ctx.isProjectTrusted() ? projectSettingsPath : globalSettingsPath;
    const root = ctx.isProjectTrusted() ? cwd : agentDir;
    await safeDestination(root, path);
    // Never replace a malformed existing file with defaults: validation throws first.
    const current = validateSettings(await readObject(path));
    let update = validated;
    if (toggleName !== undefined) {
      const global =
        path === globalSettingsPath ? {} : validateSettings(await readObject(globalSettingsPath));
      const effective = { ...defaults, ...global, ...current };
      const disabled = new Set(effective.disabledAgents.map(key));
      if (forceEnable || disabled.has(toggleName)) disabled.delete(toggleName);
      else disabled.add(toggleName);
      update = { ...validated, disabledAgents: [...disabled].toSorted() };
    }
    await atomicWrite(path, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`);
    await reload();
  }

  /** Copy a built-in or package definition to a local file that shadows it. */
  async function ejectDefinition(definition: AgentDefinition): Promise<string> {
    const root = ctx.isProjectTrusted() ? cwd : agentDir;
    const directory = ctx.isProjectTrusted()
      ? join(cwd, ".pi", "agents")
      : join(agentDir, "agents");
    const path = join(directory, `${safeName(definition.name)}.md`);
    await safeDestination(root, path);
    try {
      await lstat(path);
      throw new Error(`Refusing to overwrite ${path}.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicWrite(path, serializeAgent(definition));
    await reload();
    return path;
  }

  async function writeDefinition(
    definition: AgentDefinition,
    options: SaveOptions = {},
  ): Promise<string> {
    const trusted = ctx.isProjectTrusted();
    const user = definition.source === "user" || !trusted;
    const source = user ? "user" : "project";
    const directory = user ? join(agentDir, "agents") : join(cwd, ".pi", "agents");
    const own =
      definition.file !== undefined &&
      (definition.source === "project" || definition.source === "user");
    const path =
      own && definition.file
        ? resolve(definition.file)
        : join(directory, `${safeName(definition.name)}.md`);
    // Use the folder the file loads from as the root, so a symlinked agents folder can be saved.
    const root = agentRoots(trusted)
      .filter((candidate) => candidate.source === source)
      .map((candidate) => join(candidate.dir, "agents"))
      .find((candidate) => contained(candidate, path));
    if (!root) throw new Error(`Unsafe destination: ${path}`);
    await safeDestination(root, path);
    // Project files must also stay inside the trusted project.
    if (!user) await safeDestination(cwd, path);
    const normalized = parseAgent(serializeAgent(definition), path, source);
    const content = serializeAgent(normalized);
    // Match the load limit, so a successful save can always be reloaded.
    if (Buffer.byteLength(content) > maxResourceBytes)
      throw new Error("The definition exceeds 1 MiB and was not saved.");
    try {
      await lstat(path);
      if (!own && !options.overwrite) throw new OverwriteError(path);
      const existing = parseAgent(await checkedFile({ root, file: path }), path, source);
      if (key(existing.name) !== key(normalized.name))
        throw new Error("Refusing to overwrite another agent's configuration.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicWrite(path, content);
    await reload();
    return path;
  }

  const catalog: Catalog = {
    get settings() {
      return settings;
    },

    get warnings() {
      return [...warnings];
    },

    definitions: () => definitions,

    stored: (name) => intrinsic.get(key(name)),

    resolve(name) {
      const definition = lookup.get(key(name));
      if (!definition)
        throw new Error(
          `Unknown subagent: ${name}. Available: ${definitions
            .filter((item) => item.enabled)
            .map((item) => item.name)
            .join(", ")}.`,
        );
      if (!definition.enabled) throw new Error(`Subagent ${definition.name} is disabled.`);
      return definition;
    },

    reload: () => enqueue(reload),

    saveSettings: (patch) => enqueue(() => persist(patch)),

    toggle: (name) =>
      enqueue(async () => {
        const id = key(name);
        const definition = intrinsic.get(id);
        if (!definition) throw new Error(`Unknown subagent: ${name}`);
        if (!definition.enabled) {
          // Local files change in place. Built-in and package agents get a local enabled copy.
          if (definition.source === "user" || definition.source === "project")
            await writeDefinition({ ...definition, enabled: true });
          else await ejectDefinition({ ...definition, enabled: true });
          await persist({}, id, true);
        } else {
          await persist({}, id);
        }
      }),

    eject: (name) =>
      enqueue(async () => {
        const definition = intrinsic.get(key(name));
        if (!definition) throw new Error(`Unknown subagent: ${name}`);
        return ejectDefinition(definition);
      }),

    saveDefinition: (definition, options) => enqueue(() => writeDefinition(definition, options)),

    prompt: (definition) => agentPrompt(definition, skills, ctx),
  };
  await enqueue(reload);
  return catalog;
}

interface ResourceFile {
  file: string;
  root: string;
  packageName?: string;
}

/** All traversed directories and individual symlink targets must remain inside the root. */
async function resourceFiles(
  root: string,
  extensions: readonly string[],
  warn: (message: string) => void,
  boundary = root,
): Promise<string[]> {
  let canonical: string;
  try {
    canonical = await realpath(boundary);
    if (!contained(canonical, await realpath(root)))
      throw new Error(`Resource escapes its root: ${root}`);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  const seen = new Set<string>();
  let budget = 10000;

  async function visit(path: string, depth: number): Promise<void> {
    if (--budget < 0 || depth > 16) throw new Error(`Resource traversal limit reached: ${root}`);
    const target = await realpath(path);
    if (!contained(canonical, target)) throw new Error(`Resource escapes its root: ${path}`);
    if (seen.has(target)) return;
    seen.add(target);
    const info = await stat(target);
    if (info.isFile()) {
      if (extensions.some((extension) => path.endsWith(extension))) files.push(path);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await readdir(path);
    entries.sort();
    for (const name of entries) {
      // A declared node_modules root may be inspected directly, but never searched incidentally.
      if (name === "node_modules") continue;
      try {
        await visit(join(path, name), depth + 1);
      } catch (error) {
        warn(String(error));
      }
      if (budget < 0) break;
    }
  }

  await visit(root, 0);
  return files.toSorted();
}

const resourceManifest = Type.Object({
  name: Type.Optional(Type.String()),
  pi: Type.Optional(
    Type.Object({
      subagents: Type.Optional(
        Type.Object({ agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }),
      ),
    }),
  ),
});

async function declaredFiles(
  root: string,
  entries: string[],
  extensions: readonly string[],
  warn: (message: string) => void,
): Promise<string[]> {
  const canonical = await realpath(root);
  const selected = new Set<string>();
  for (const entry of entries) {
    const exclude = entry.startsWith("!") || entry.startsWith("-");
    const pattern = entry.replace(/^[!+-]/, "").replace(/^\.\//, "");
    if (
      !pattern ||
      isAbsolute(pattern) ||
      pattern.includes("\\") ||
      pattern.split("/").includes("..")
    ) {
      throw new Error(`Unsafe package resource path: ${entry}`);
    }
    const hasGlob = /[*?[\]{}]/.test(pattern);
    let candidates: string[];
    if (hasGlob) {
      const parts = pattern.split("/");
      const prefix: string[] = [];
      for (const part of parts) {
        if (/[*?[\]{}]/.test(part)) break;
        prefix.push(part);
      }
      const base = resolve(root, ...prefix);
      const target = await realpath(base).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!target) continue;
      if (!contained(canonical, target))
        throw new Error(`Package resource escapes package: ${entry}`);
      candidates = (await resourceFiles(base, extensions, warn, root)).filter((file) =>
        matchesGlob(relative(root, file).split(sep).join("/"), pattern),
      );
    } else {
      const path = resolve(root, pattern);
      const target = await realpath(path).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!target) continue;
      if (!contained(canonical, target))
        throw new Error(`Package resource escapes package: ${entry}`);
      // Pass the package root as the boundary for individual files and directory contents.
      const info = await stat(path);
      candidates = info.isDirectory()
        ? await resourceFiles(path, extensions, warn, root)
        : extensions.some((extension) => path.endsWith(extension))
          ? [path]
          : [];
    }
    for (const file of candidates) {
      if (!contained(canonical, await realpath(file)))
        throw new Error(`Package resource escapes package: ${file}`);
      if (exclude) selected.delete(file);
      else selected.add(file);
    }
  }
  return [...selected].toSorted();
}

async function packageResources(
  cwd: string,
  agentDir: string,
  trusted: boolean,
  settings: Settings,
  warn: (message: string) => void,
): Promise<ResourceFile[]> {
  const hostSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  for (const error of hostSettings.drainErrors()) warn(`Package settings: ${error.error.message}`);
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: hostSettings });
  const result: ResourceFile[] = [];
  const packages = manager
    .listConfiguredPackages()
    .filter((item) => trusted || item.scope === "user");
  packages.sort((a, b) =>
    a.scope === b.scope ? a.source.localeCompare(b.source, "en") : a.scope === "user" ? -1 : 1,
  );
  const seen = new Set<string>();
  for (const item of packages) {
    try {
      const installed = item.installedPath ?? manager.getInstalledPath(item.source, item.scope);
      if (!installed) {
        warn(`Configured package is not installed: ${item.source}`);
        continue;
      }
      const root = await realpath(installed);
      const identity = `${item.scope}:${root}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const manifestPath = join(root, "package.json");
      if (!contained(root, await realpath(manifestPath)))
        throw new Error("Package manifest escapes package root.");
      const manifest: unknown = JSON.parse(await readText(manifestPath));
      if (!Value.Check(resourceManifest, manifest))
        throw new Error("Invalid subagent resource declaration.");
      if (!manifest.pi?.subagents?.agents) continue;
      const name = manifest.name || item.source;
      const policy = settings.packageAgents;
      if (
        policy === false ||
        (Array.isArray(policy) && !policy.includes(name) && !policy.includes(item.source))
      )
        continue;
      for (const file of await declaredFiles(root, manifest.pi.subagents.agents, [".md"], warn)) {
        result.push({ file, root, packageName: name });
      }
    } catch (error) {
      warn(`Package ${item.source}: ${String(error)}`);
    }
  }
  return result;
}
