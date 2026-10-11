# @luxass/opencode-personal

## 0.1.0

### Minor Changes

- [#10](https://github.com/luxass/agent-extensions/pull/10) [`c9a6f47`](https://github.com/luxass/agent-extensions/commit/c9a6f4730a5a52c3545df15c218805b1c6e48b08) Thanks [@luxass](https://github.com/luxass)! - Add personal OpenCode V2 plugins in one package, with fixed defaults like pi-personal. Include Git interception and generated worker-file protection from dots, plus the Socket Firewall package-manager guard from Pi personal. Keep each feature as a native OpenCode `Plugin.define` module and keep composition inline in the package entry point. Run cleanup functions in reverse order on unload or failed setup.
