import { relative } from "node:path";

import type {
  ExtensionAPI,
  ResourceDiagnostic,
  ResourceLoader,
  SourceInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

export type LoaderDiagnostic = ResourceDiagnostic & {
  resource: "Extensions" | "Skills" | "Prompts" | "Themes";
};

export type ResourceTool = Pick<ToolInfo, "name" | "description" | "exposure"> & {
  active: boolean;
};

export type ResourceSnapshot = {
  context: string[];
  skills: string[];
  extensions: SourceInfo[];
  tools: ResourceTool[];
  diagnostics: LoaderDiagnostic[];
};

function diagnosticsFor(
  resource: LoaderDiagnostic["resource"],
  diagnostics: ResourceDiagnostic[],
): LoaderDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, resource }));
}

interface CollectResourceOptions {
  pi: ExtensionAPI;
  loader: ResourceLoader;
  cwd: string;
}

export function collectResources({ pi, loader, cwd }: CollectResourceOptions): ResourceSnapshot {
  const activeTools = new Set(pi.getActiveTools());
  const loadedExtensions = loader.getExtensions();
  const loadedSkills = loader.getSkills();
  const systemPrompt = loader.getSystemPromptSource();
  const contextSources = [
    ...(systemPrompt ? [systemPrompt] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];

  const tools = pi
    .getAllTools()
    .map(({ name, description, exposure }) => ({
      name,
      description,
      exposure,
      active: activeTools.has(name),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const context = contextSources.map(({ path }) => relative(cwd, path));
  const skills = loadedSkills.skills.map((skill) => skill.name).toSorted();
  const extensions = loadedExtensions.extensions
    .filter((extension) => !extension.hidden)
    .map((extension) => extension.sourceInfo)
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const diagnostics = [
    ...loadedExtensions.errors.map(({ path, error }): LoaderDiagnostic => ({
      resource: "Extensions",
      type: "error",
      message: error,
      path,
    })),
    ...(loadedExtensions.warnings ?? []).map(({ path, warning }): LoaderDiagnostic => ({
      resource: "Extensions",
      type: "warning",
      message: warning,
      path,
    })),
    ...diagnosticsFor("Skills", loadedSkills.diagnostics),
    ...diagnosticsFor("Prompts", loader.getPrompts().diagnostics),
    ...diagnosticsFor("Themes", loader.getThemes().diagnostics),
  ];

  return { tools, context, skills, extensions, diagnostics };
}
