# @luxass/opencode-personal

Collects [OpenCode](https://opencode.ai) V2 plugins that are tuned to a single personal workflow rather than general enough to ship on their own.

## Install

After publication, add the package to the existing `plugins` array in `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugins": ["@luxass/opencode-personal"]
}
```

To review the checkout before publication, use its absolute directory path instead of the npm package name. Restart OpenCode after changes.

## What it does

Crow connects OpenCode to CLIProxyAPI (CPA). It discovers models and their metadata from CPA and uses OpenCode's model catalog for price estimates.

The Git interceptor sets `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, and `GIT_MERGE_AUTOEDIT=no` for shell invocations. It denies shell permission requests that contain `--no-verify`.

The package-manager interceptor requires Socket Firewall for common install and execution commands from pnpm, npm, Bun, Yarn, and npx. Retry an unwrapped command with `sfw` before the package manager, such as `sfw pnpm install`. The interceptor denies the command without rewriting it.

The worker configuration guard denies direct edits to `worker-configuration.d.ts` and common shell mutations of that file. Run `wrangler types` to regenerate it. These checks are safeguards for common operations, not a complete security boundary.

These defaults suit one workflow and are meant to be edited in place rather than configured through settings. Each feature is a native OpenCode `Plugin.define` object in its own source file. It registers its own hooks in `setup` and returns its cleanup function. There is no custom feature-definition API.

The package entry point keeps its plugin list and lifecycle handling inline. It loads Crow, the Git interceptor, the package-manager interceptor, and the worker configuration guard.

To add a feature, define an OpenCode plugin with `Plugin.define`, import it, and add it to the list. Remove an entry to stop loading it. Plugins start in list order with the package's OpenCode context.

The entry point runs plugin cleanup functions in reverse order on unload or failed setup. It attempts every plugin cleanup even if one fails. The package exports `./crow`, `./git-interceptor`, `./package-manager-interceptor`, and `./worker-configuration-guard` for independent use.

The Git and worker guards come from [dots](https://github.com/luxass/dots/tree/main/home/.config/opencode/plugins). The package-manager guard is a port of the Pi personal extension. Before enabling this package, move `git-interceptor.ts` and `worker-configuration-guard.ts` out of OpenCode's automatically loaded `plugins/` directory. Keep backup copies until the review is complete. Remove any explicit registrations of those files too, to prevent duplicate loading.

Keep the Herdr integration separate. This package does not replace it.

## Crow

Run `opencode auth login crow` in a project that loads this package. Select the API-key method. Enter the Crow base URL and API key when OpenCode asks. The default URL is `http://127.0.0.1:8317`. OpenCode saves the credential in its own storage. Crow does not read or copy Pi credentials.

You can also set `CLIPROXYAPI_API_KEY` before you start OpenCode. Set `CLIPROXYAPI_BASE_URL` to use another address. OpenCode chooses the active connection. The base URL environment variable overrides the saved URL.

Crow requests model metadata at `/v1/models?client_version=opencode` and sends inference requests to `/v1/responses`. Base URLs can include a path prefix or end with `/v1`.

Limits, input types, and reasoning levels come from CPA. Models without an ID or marked hidden are omitted. Models remain available without an OpenCode catalog match. Matching catalog entries supply price estimates. Models without a match have an empty cost list. These estimates do not describe CPA's actual charges.

Missing limits default to 128,000 context tokens and 16,384 output tokens. Missing input types default to text. Reasoning variants use CPA's effort names, with `none` displayed as `off`.

Crow refreshes models at startup and after credential changes. Run `/cliproxyapi-refresh` to request another refresh. Each refresh clears the previous model list. If discovery fails, the list stays empty until a successful refresh. Crow does not persist a model cache.

Crow uses OpenCode's native HTTP Responses streaming, retry handling, and local compaction. It adds no notifications, feature settings, or TUI component.

## License

[MIT](LICENSE).
