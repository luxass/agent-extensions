---
"@luxass/pi-questions": patch
"@luxass/opencode-voice": patch
---

Validate with `@earendil-works/pi-schema` instead of TypeBox. `pi-questions` no longer needs a `typebox` peer dependency, and `opencode-voice` reports option errors by field path, for example `/keybind`.
