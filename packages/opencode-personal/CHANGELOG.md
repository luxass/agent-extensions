# @luxass/opencode-personal

## 0.2.0

### Minor Changes

- [#12](https://github.com/luxass/agent-extensions/pull/12) [`a2b3899`](https://github.com/luxass/agent-extensions/commit/a2b38997f19b69581e2f31885f6ca729abccd49a) Thanks [@luxass](https://github.com/luxass)! - Add a native Crow provider for CPA with API-key login and model discovery. Read model metadata from CPA, including models absent from OpenCode's catalog. Use matching OpenCode price estimates and native HTTP Responses streaming. Refresh available models after credential changes or with `/cliproxyapi-refresh`.

## 0.1.0

### Minor Changes

- [#10](https://github.com/luxass/agent-extensions/pull/10) [`c9a6f47`](https://github.com/luxass/agent-extensions/commit/c9a6f4730a5a52c3545df15c218805b1c6e48b08) Thanks [@luxass](https://github.com/luxass)! - Add personal OpenCode V2 plugins in one package, with fixed defaults like pi-personal. Include Git interception and generated worker-file protection from dots, plus the Socket Firewall package-manager guard from Pi personal. Keep each feature as a native OpenCode `Plugin.define` module and keep composition inline in the package entry point. Run cleanup functions in reverse order on unload or failed setup.
