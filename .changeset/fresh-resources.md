---
"@luxass/pi-resources": minor
"@luxass/pi-personal": minor
---

Move `/resources` from `@luxass/pi-personal` into the standalone `@luxass/pi-resources` package. Install the new package to keep the command. Preserve the active resource-loader hook and all five tabs while simplifying loader state and tab summaries. The personal header shows the shortcut only when the command is available.

Use compact tab labels and shorter summaries on small screens. Tools starts collapsed, with `e` to show descriptions and exposure explanations.
