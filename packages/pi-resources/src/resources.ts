import { relative } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ResourceDiagnostic,
  ResourceLoader,
  SourceInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

export type LoaderDiagnostic = ResourceDiagnostic & {
  resource: "Extensions" | "Skills" | "Prompts" | "Themes";
};

export type ResourceSnapshot = {
  context: string[];
  skills: string[];
  extensions: SourceInfo[];
  tools: (Pick<ToolInfo, "name" | "description" | "exposure"> & { active: boolean })[];
  diagnostics: LoaderDiagnostic[];
};

function diagnosticsFor(
  resource: LoaderDiagnostic["resource"],
  diagnostics: ResourceDiagnostic[],
): LoaderDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, resource }));
}

interface CollectResourceOptions {
  ctx: ExtensionContext;
  loader: ResourceLoader;
}

export function collectResources(
  pi: ExtensionAPI,
  { ctx, loader }: CollectResourceOptions,
): ResourceSnapshot {
  const activeTools = new Set(pi.getActiveTools());
  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  const systemPrompt = loader.getSystemPromptSource();
  const context = [
    ...(systemPrompt ? [systemPrompt] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];

  return {
    tools: pi
      .getAllTools()
      .map(({ name, description, exposure }) => ({
        name,
        description,
        exposure,
        active: activeTools.has(name),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    context: context.map(({ path }) => relative(ctx.cwd, path)),
    skills: skills.skills.map((skill) => skill.name).toSorted(),
    extensions: extensions.extensions
      .filter((extension) => !extension.hidden)
      .map((extension) => extension.sourceInfo)
      .toSorted((a, b) => a.path.localeCompare(b.path)),
    diagnostics: [
      ...extensions.errors.map(({ path, error }): LoaderDiagnostic => ({
        resource: "Extensions",
        type: "error",
        message: error,
        path,
      })),
      ...(extensions.warnings ?? []).map(({ path, warning }): LoaderDiagnostic => ({
        resource: "Extensions",
        type: "warning",
        message: warning,
        path,
      })),
      ...diagnosticsFor("Skills", skills.diagnostics),
      ...diagnosticsFor("Prompts", loader.getPrompts().diagnostics),
      ...diagnosticsFor("Themes", loader.getThemes().diagnostics),
    ],
  };
}
