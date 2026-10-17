---
name: new-extension
description: Bootstrap a Pi extension or OpenCode plugin in this repository. Use when adding, scaffolding, or setting up a new extension package, including its entry point, dependencies, README, license, banner, and Changeset.
---

# New extension

Create one package for each host. Keep the implementation small and follow the current repository conventions.

Resolve repository paths from this skill directory: `../../../` is the repository root. Run commands from that root.

## Establish the scope

1. Read [AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md), [package.json](../../../package.json), and [pnpm-workspace.yaml](../../../pnpm-workspace.yaml).
2. Inspect `git status --short`. Do not overwrite an existing package.
3. Determine the host (`pi` or `opencode`), feature name, and requested behavior. Ask about missing decisions before writing files.
4. Use `packages/<host>-<feature>` and `@luxass/<host>-<feature>`. Use lowercase words separated by hyphens.
5. If both hosts are requested, create separate packages. Share code only when both implementations need it.

When a decision needs user input, use an available question UI tool instead of plain chat. Prefer `ask_questions` or `ask_user_question`, or the host's equivalent question tool. If tools are deferred, look for a question tool before falling back to chat. Batch related decisions and ask only for information the user has not supplied. If no question UI tool is available, ask in plain chat. Treat cancellation or unanswered questions as undecided, not approval. Apply this rule to dependency approval too.

Follow the repository-wide rules in [AGENTS.md](../../../AGENTS.md), including dependency approval, manual testing, and permission to publish changes.
Do not add Turbo, a generator, a build step, or another task runner.

## Create the package

Create `package.json`, `src/index.ts`, `tsconfig.json`, `README.md`, and `LICENSE` inside the package directory.
Copy the repository's root MIT license into the new package. Do not change existing package licenses.

Set the manifest fields as follows:

- Use version `0.0.0`, a factual description, `"type": "module"`, and `"license": "MIT"`.
- Use the repository URL from a sibling package. Set `repository.directory` to the new package directory.
- Set `publishConfig.access` to `public`.
- Limit `files` to `src`, `README.md`, and `LICENSE`. Keep the cover in the repository for its public URL.
- Copy the following scripts.

```json
{
  "scripts": {
    "lint": "oxlint .",
    "lint:fix": "oxlint --fix .",
    "fmt": "oxfmt .",
    "fmt:check": "oxfmt --check .",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

Use the shared compiler configuration:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

Add package-specific compiler settings only when the implementation requires them. Do not weaken the shared rules.

## Choose the host integration

### Pi

Read [pi-whimsical/package.json](../../../packages/pi-whimsical/package.json) for a small package manifest.
Read [pi-questions/package.json](../../../packages/pi-questions/package.json) when the extension needs tools or terminal UI.
Inspect the installed Pi documentation and the smallest relevant extension example before choosing APIs.

- Default-export a factory that receives `ExtensionAPI` from `@earendil-works/pi-coding-agent`.
- Set `pi.extensions` to `["./src/index.ts"]`.
- Include the keywords `pi`, `pi-extension`, and `pi-package`.
- Declare imported Pi host packages and `typebox` as `peerDependencies` with `"*"` ranges. Include only the packages actually imported.
- Put other runtime dependencies in `dependencies`. Do not bundle Pi host packages.
- Guard terminal-only behavior with `ctx.mode === "tui"`. Start resources when needed and clean them up on session shutdown.

### OpenCode

Read [opencode-personal/package.json](../../../packages/opencode-personal/package.json) and its [plugin entry point](../../../packages/opencode-personal/src/dependency-policy.ts).
Read the installed `@opencode/plugin` declarations before choosing hooks or lifecycle APIs. Do not copy APIs from older OpenCode versions.

- Use `Plugin.define` from `@opencode/plugin` with a unique plugin `id` and `setup` function.
- Default-export the plugin. Return cleanup from `setup` when the plugin acquires resources or registers disposable hooks.
- Set `exports` to `{ ".": "./src/index.ts" }`.
- Include the keywords `opencode` and `opencode-plugin`. Do not add a `pi` manifest.
- Declare `@opencode/plugin` in `dependencies` using `catalog:opencode`. Add other dependencies only when required by the implementation.
- Match the existing `engines.node` requirement. Add separate exports for additional entry points only when needed.

## Handle dependencies

Follow the [dependency policy](../../../AGENTS.md#dependencies) before declaring the new package's dependencies.
Reuse the current workspace catalogs. Do not copy version numbers from sibling packages or upgrade unrelated resolutions.
After approval, run `sfw pnpm install --lockfile-only` to update the lockfile for the new package. Inspect the diff for unrelated changes.

## Document and register the extension

Follow [pi-voice/README.md](../../../packages/pi-voice/README.md) or [opencode-voice/README.md](../../../packages/opencode-voice/README.md) for the README structure.
Use the package name as the heading, then a short introduction, `Install`, and `Use`. Add a controls table only when useful.

- For Pi, show `pi install npm:@luxass/pi-<feature>`. Document local use with `pi -e ./packages/pi-<feature>` when relevant.
- For OpenCode, copy the current sibling installation format and replace its package name. Do not edit the user's global configuration.
- Describe only implemented behavior and real requirements. Do not add an exhaustive tool-schema example or implementation notes.
- Add the package to the matching table in the root [README.md](../../../README.md).
- Add a cover component under `scripts/covers/` and register it in [generate.tsx](../../../scripts/covers/generate.tsx).
- Reuse the existing cover layout, typography, and colors. Run `pnpm covers` and include `packages/<host>-<feature>/docs/cover.png`.
- For Pi, set `pi.image` to the raw GitHub URL on `main`, following sibling packages. Do not claim that URL works before merge.
- Add a Changeset for the new package with a `minor` bump and a short user-facing summary. Do not edit generated changelogs.

## Validate and report

Run `pnpm --filter <package> typecheck`, replacing `<package>` with the full npm package name.
Then run the root checks documented in [Checks and fixes](../../../CONTRIBUTING.md#checks-and-fixes), following the [validation policy](../../../AGENTS.md#validation).

Inspect the final diff. Make sure every entry point, README link, cover registration, and Changeset names the new package correctly.
Report the created files, the commands that passed, and any remaining manual host checks.
