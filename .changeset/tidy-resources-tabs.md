---
"@luxass/pi-personal": patch
---

Redesign `/resources` with Tools, Context, Skills, and Extensions tabs. Open on Tools and support keyboard navigation, clickable tabs, mouse-wheel scrolling in fullscreen mode, and scroll position indicators. Show skills in compact columns and group extensions by Pi’s source metadata instead of guessing names from folders. Replace the sibling-file scan and command/tool inference with a temporary resource-loader hook that reads the loaded extension list, including event-only extensions. Limit the dialog size on large terminals.
