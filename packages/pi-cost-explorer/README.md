# @luxass/pi-cost-explorer

See where a [Pi](https://pi.dev) session spent its money. The cost explorer breaks the session down by model, prompt, tool, and request in a tabbed dialog.

## Install

```sh
pi install npm:@luxass/pi-cost-explorer
```

To try the extension from this checkout:

```sh
pi -e ./packages/pi-cost-explorer
```

## Use

Run `/cost` in Pi's terminal interface. The dialog has five tabs:

- **Overview** shows the total cost, token counts, and the cost split between input, output, cache reads, and cache writes. It also shows the cache hit rate, averages, a cost-over-time sparkline, cost by source, and the most expensive model, prompt, and tool.
- **Models** shows requests, tokens, cache hit rate, and cost for each provider and model.
- **Turns** lists each prompt you sent with the cost of everything it caused. Press Enter to see the prompt's breakdown and each usage record.
- **Tools** shows calls, errors, run time, and cost for each tool.
- **Requests** lists every priced event in time order. Press Enter to see its full token and cost breakdown.

The totals use the same sources as Pi's `/session` command: model responses, usage that tools report for their own model calls, background usage such as cache warming, and compaction and branch summaries.

A Pi session branches when you go back to an earlier message and continue from there. These session branches are not Git branches. By default the dialog covers every session branch, and rows from other branches are dimmed. Press `b` to show only the current branch. While the dialog is open, it refreshes after each turn.

| Controls                     | Action                                                   |
| ---------------------------- | -------------------------------------------------------- |
| Left, Right, Tab, Shift+Tab  | Switch tabs.                                             |
| `1`–`5`                      | Jump to a tab.                                           |
| Up, Down, Page Up, Page Down | Move the selection or scroll.                            |
| Home, End                    | Go to the first or last row.                             |
| Enter                        | Open the selected prompt or request.                     |
| Esc                          | Go back from a detail screen, or close.                  |
| `s`                          | Switch between the two sort orders of a list.            |
| `b`                          | Switch between all session branches and the current one. |
| `r`                          | Refresh.                                                 |
| `q`                          | Close.                                                   |
| Click or mouse wheel         | Switch tabs, select or open rows, or scroll.             |

Mouse input works in fullscreen mode only.

### Limits

- Costs come from the prices in Pi's model configuration. If a model has no price, its requests show $0 and the Overview shows a warning.
- The **≈ Calling** column in Tools is an estimate. One request can call several tools, so it splits the request's cost evenly between them. The **Nested** column is exact: it is usage that a tool reports for its own model calls, for example subagents.
