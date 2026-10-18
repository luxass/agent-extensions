---
"@luxass/pi-personal": patch
---

Show the remaining cooldown duration and absolute UTC retry time in Crow errors when CLIProxyAPI provides reset_seconds. Keep the original proxy error and label the timing as the next allowed retry, not a guaranteed quota reset.
