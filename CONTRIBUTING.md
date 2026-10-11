# Contributing

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Checks and fixes

Run these commands from the repository root:

| Command          | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `pnpm typecheck` | Check root tooling configs and every workspace package with TypeScript.  |
| `pnpm lint`      | Run type-aware Oxlint checks. Warnings fail the command.                 |
| `pnpm lint:fix`  | Apply safe lint fixes, then report remaining issues.                     |
| `pnpm fmt`       | Format files and sort imports with Oxfmt.                                |
| `pnpm fmt:check` | Check formatting without writing files.                                  |
| `pnpm check`     | Run lint, formatting checks, typechecking, and the current test command. |

Every package also exposes `typecheck`, `lint`, `lint:fix`, `fmt`, and `fmt:check`. Run them inside the package or use a filter:

```sh
pnpm --filter @luxass/pi-btw typecheck
pnpm --filter @luxass/pi-voice lint
```

CI runs the same root lint, formatting, and typecheck commands. Checks do not fix files automatically.

## Configuration ownership

- `tsconfig.base.json` owns shared compiler settings.
- Root `tsconfig.json` checks `*.config.ts` tooling files.
- Each package's `tsconfig.json` extends the base and includes `src/**/*.ts` and `tests/**/*.ts`.
- `oxlint.config.ts` owns lint rules for the whole repository, including package-local commands. Oxlint uses type information but leaves compiler diagnostics to `tsc`.
- `oxfmt.config.ts` owns formatting and import sorting. Do not add competing formatting rules to Oxlint.
- `pnpm-workspace.yaml` catalogs pin tool and Pi versions.

Extensions publish TypeScript source, without a build step. The shared compiler settings use `Preserve` modules and `Bundler` resolution for Pi's TypeScript loader. Node types are explicit, and the standard library targets ES2023 to include non-mutating array APIs supported by Node.js 24, without assuming a browser environment.

Keep `strict`, unchecked-index checks, override checks, and unused-code checks enabled. Unused callback parameters can use an underscore prefix. `exactOptionalPropertyTypes` is not enabled yet; adopting it needs a separate review of optional fields and dependency types.

Prefer fixing a lint finding. When a suppression is necessary, keep it local and explain why. Unused lint suppressions fail checks. New safety rules should be explicit rather than enabling the entire pedantic category.

## Adding a plugin

Keep packages directly under `packages/`. Name host-specific directories `<host>-<feature>`, such as `pi-btw` or `opencode-voice`. Keep existing npm package names stable when moving directories.

Keep host APIs and entry points in their own packages. Add shared packages only when multiple plugins need the same code. Declare shared runtime packages as dependencies, rather than importing source from sibling directories. Shared packages must be published before or with the plugins that depend on them.

Create a package with a `package.json`, `src/`, and this `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Use the same scripts as existing packages:

```json
{
  "scripts": {
    "fmt": "oxfmt .",
    "fmt:check": "oxfmt --check .",
    "lint": "oxlint --deny-warnings .",
    "lint:fix": "oxlint --fix --deny-warnings .",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

Keep the published `files` list limited to source and package documentation. Tests belong in `tests/`, outside published `src/`. Declare runtime dependencies in the package manifest. Pi packages declare entry points under `pi.extensions`. OpenCode packages declare the exports required by their target OpenCode version. Keep host dependencies in the packages that need them.

Extend the shared TypeScript configuration. Add package-specific compiler settings when the host requires them. Do not assume that every host uses Pi's loader or runtime.

Root typechecking executes `tsc` in every workspace package directly. A missing package typecheck script cannot silently skip the package, and a missing `tsconfig.json` fails the check.

## Tests

Don't write tests!
