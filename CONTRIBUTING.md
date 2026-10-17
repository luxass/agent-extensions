# Contributing

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Agent-specific rules live in [AGENTS.md](AGENTS.md).

## Checks and fixes

Run these commands from the repository root:

| Command          | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `pnpm typecheck` | Check root tooling configs and every workspace package with TypeScript. |
| `pnpm lint`      | Run type-aware Oxlint checks. Errors fail the command.                  |
| `pnpm lint:fix`  | Apply safe lint fixes, then report remaining issues.                    |
| `pnpm fmt`       | Format files and sort imports with Oxfmt.                               |
| `pnpm fmt:check` | Check formatting without writing files.                                 |
| `pnpm check`     | Run lint, formatting checks, and typechecking.                          |

CI runs the same root lint, formatting, and typecheck commands. Checks do not fix files automatically. Root lint and formatting cover the whole repository. Root typechecking checks tooling and runs `tsc` in every workspace package.

Each package exposes `typecheck`, `lint`, `lint:fix`, `fmt`, and `fmt:check`. To work on one package, use a filter:

```sh
pnpm --filter @luxass/pi-btw typecheck
pnpm --filter @luxass/pi-voice lint
```

There is no automated test suite. The maintainer tests extensions manually in Pi and OpenCode.

## Configuration ownership

- `tsconfig.base.json` owns shared compiler settings.
- Root `tsconfig.json` checks `*.config.ts` tooling files.
- Each package's `tsconfig.json` extends the base and includes `src/**/*.ts`.
- `oxlint.config.ts` owns lint rules for the whole repository, including package-local commands.
- `oxfmt.config.ts` owns formatting and import sorting.
- `pnpm-workspace.yaml` catalogs pin shared dependency versions.

Oxlint uses type information but leaves compiler diagnostics to `tsc`. Rule severity lives in `oxlint.config.ts`: `error` fails the command, `warn` reports advice, and `off` disables the rule.

Packages ship TypeScript source without a build step. Shared compiler settings use `Preserve` modules, `Bundler` resolution, explicit Node types, and the ES2023 standard library.

Keep the shared compiler checks enabled. Add package-specific settings only when the host requires them. Keep lint suppressions local and explain why they are necessary. Unused suppressions fail checks.

## Adding a plugin

Keep packages directly under `packages/`, with names such as `pi-btw` or `opencode-voice`. Each package has its own manifest, source entry point, compiler configuration, README, and MIT license.

Keep host APIs and entry points in separate packages. Pi packages declare entry points under `pi.extensions`. OpenCode packages declare their entry points through `exports`. Follow the matching sibling package and the current host API.

Use the shared compiler and tooling configuration. Limit published files to source and package documentation. Keep README structure consistent: a short introduction, `Install`, and `Use`.

Add the package to the root README, register its banner in the cover generator, and add a Changeset. Shared runtime packages must be declared as dependencies and published before or with their consumers.

The [new-extension skill](.agents/skills/new-extension/SKILL.md) contains the detailed bootstrap procedure for either host. [AGENTS.md](AGENTS.md#new-extensions) explains how to invoke it.

## Releases

Use a Changeset to describe user-facing package changes and select the version bump. The configuration lives in `.changeset/config.json`.

The release workflow on `main` creates or updates a version PR, then publishes packages after the version changes merge. Generated changelogs and version updates belong to that workflow. See [.github/workflows/release.yaml](.github/workflows/release.yaml) for the release jobs.
