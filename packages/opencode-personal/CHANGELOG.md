# @luxass/opencode-personal

## 0.2.3

### Patch Changes

- [#32](https://github.com/luxass/agent-extensions/pull/32) [`69da11f`](https://github.com/luxass/agent-extensions/commit/69da11fb207a4d94683e4128cc09a89fac467035) Thanks [@goldenmonkeyrnd](https://github.com/goldenmonkeyrnd)! - Support OpenCode 2.1.1 by updating the OpenCode plugin and OpenTUI catalog versions, and adapting Crow to the current credential and provider settings schema.

## 0.2.2

### Patch Changes

- [`4105517`](https://github.com/luxass/agent-extensions/commit/410551742e6828297ef5ac88d662f15c3b191acc) Thanks [@luxass](https://github.com/luxass)! - Preserve Git commit signing settings for commits and rebases. Block common signing bypasses and instruct the model to ask for help when signing fails. Leave repositories with signing disabled unchanged.

## 0.2.1

### Patch Changes

- [#14](https://github.com/luxass/agent-extensions/pull/14) [`5afe207`](https://github.com/luxass/agent-extensions/commit/5afe207807f34b244f726264d870bfd01e8f697c) Thanks [@luxass](https://github.com/luxass)! - Add a model instruction that requires explicit user approval before adding, replacing, or upgrading dependencies. Keep routine installs of existing dependencies allowed through Socket Firewall.

## 0.2.0

### Minor Changes

- [#12](https://github.com/luxass/agent-extensions/pull/12) [`a2b3899`](https://github.com/luxass/agent-extensions/commit/a2b38997f19b69581e2f31885f6ca729abccd49a) Thanks [@luxass](https://github.com/luxass)! - Add a native Crow provider for CPA with API-key login and model discovery. Read model metadata from CPA, including models absent from OpenCode's catalog. Use matching OpenCode price estimates and native HTTP Responses streaming. Refresh available models after credential changes or with `/cliproxyapi-refresh`.

## 0.1.0

### Minor Changes

- [#10](https://github.com/luxass/agent-extensions/pull/10) [`c9a6f47`](https://github.com/luxass/agent-extensions/commit/c9a6f4730a5a52c3545df15c218805b1c6e48b08) Thanks [@luxass](https://github.com/luxass)! - Add personal OpenCode V2 plugins in one package, with fixed defaults like pi-personal. Include Git interception and generated worker-file protection from dots, plus the Socket Firewall package-manager guard from Pi personal. Keep each feature as a native OpenCode `Plugin.define` module and keep composition inline in the package entry point. Run cleanup functions in reverse order on unload or failed setup.
