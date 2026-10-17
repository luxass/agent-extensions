# Agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup commands, checks, package layout, and release guidance. Use those conventions instead of creating parallel tooling.

## Working safely

Inspect the working tree before changing files. Preserve existing work and keep edits within the requested scope. Do not overwrite unrelated changes or run automatic fixes across the repository.

Do not commit, push, publish, or create or edit a PR without explicit permission. A request for local changes is not permission to publish them.

## Dependencies

Use existing code, installed dependencies, and platform APIs first. Get explicit approval before adding, replacing, or upgrading a runtime, development, optional, or peer dependency. This includes edits to manifests, catalogs, and lockfiles.

Before asking for approval, name the dependency, explain why existing options are insufficient, and state its trade-offs. A feature request alone is not approval for dependency changes.

Run package installation commands through Socket Firewall, for example `sfw pnpm install --frozen-lockfile`. Installing already-declared dependencies is allowed when it preserves dependency choices and resolved versions. Do not bypass the firewall if it is unavailable.

## Validation

Automated tests are not viable for this repository right now. There are no automated test cases. The maintainer will test the extensions manually in Pi and OpenCode.

Do not add test files, test suites, test runners, test scripts, or test dependencies. Do not add test paths to compiler configuration or package templates.

Run the root lint, formatting, and typecheck commands documented in [Checks and fixes](CONTRIBUTING.md#checks-and-fixes). Keep lint and formatting as single root runs. Keep recursive package typechecking in the existing root command.

Report which checks passed and any remaining manual verification. Do not claim that static checks prove runtime behavior.

## New extensions

Use the [new-extension skill](.agents/skills/new-extension/SKILL.md) when creating a Pi extension or OpenCode plugin. It owns the detailed bootstrap procedure, including manifests, documentation, banners, and Changesets.

In Pi, invoke it with a host, feature name, and description:

```text
/skill:new-extension pi bookmarks Save and restore useful points in a conversation.
```

In OpenCode, use the same skill and provide the same details.
