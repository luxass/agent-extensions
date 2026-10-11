---
"@luxass/opencode-personal": minor
---

Add personal OpenCode V2 plugins in one package, with fixed defaults like pi-personal. Include Git interception and generated worker-file protection from dots, plus the Socket Firewall package-manager guard from Pi personal. Keep each feature as a native OpenCode `Plugin.define` module and keep composition inline in the package entry point. Run cleanup functions in reverse order on unload or failed setup.
