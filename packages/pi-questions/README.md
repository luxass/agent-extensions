# @luxass/pi-questions

Answer structured questions from [Pi](https://github.com/badlogic/pi-mono) with choices, custom answers, notes, and Markdown previews.

## Install

```sh
pi install npm:@luxass/pi-questions
```

Requires interactive Pi. RPC, JSON, and print modes are not supported. There are no commands or configuration files.

With Herdr's Pi integration installed and loaded, Herdr marks the agent as blocked while a questionnaire is open. The bundled `@luxass/herdr-agent-shared` library adds the sidebar label `Waiting for answers`. Include `state_text` in Herdr's agent sidebar rows to display it. No extra Pi extension is needed. Submission, cancellation, an abort, or an error clears this questionnaire's state and label. Without Herdr, questionnaires work as usual.

## Use

The model can use `ask_questions` without an explicit request. Its instructions tell it to clarify unclear goals, scope, and constraints before implementing a new system or substantial feature. It skips questions you already answered and routine implementation details. You can also ask it to use the tool explicitly.

Each questionnaire accepts one to four questions, with two to four options per question.

The questionnaire opens below the conversation in Pi's editor area. With one question, confirming an answer submits it directly. With multiple questions, selecting an option moves to the next tab. The final Review tab lets you submit or cancel.

| Key             | Action                                                     |
| --------------- | ---------------------------------------------------------- |
| Tab / Shift+Tab | Move to the next or previous tab outside text editors.     |
| Right / Left    | Move to the next or previous tab outside text editors.     |
| Up / Down       | Move between choices.                                      |
| Enter           | Choose an option, toggle a checkbox, or save custom text.  |
| Space           | Toggle an authored checkbox in a multi-select question.    |
| 1–4             | Choose the corresponding authored option.                  |
| n               | Edit a question note, or a global note on the Review tab.  |
| q / p           | Read the complete question or the focused option preview.  |
| Ctrl+]          | Collapse or expand without losing answers or drafts.       |
| Ctrl+U          | Clear the custom-answer draft while typing.                |
| Delete          | Clear the current answer outside text editors. Keep notes. |
| Escape          | Cancel, save a note, or return from a question or preview. |

Focus `Type something.` to write a custom answer. Enter saves it, and Shift+Enter adds a line. Up or Down leaves the editor at the first or last line without discarding its text. For a multi-select question, custom text counts alongside checked options. Choose Next when you finish selecting.

Outside text editors, press q to read a long question or p to read the focused option's Markdown preview. Up, Down, Home, and End scroll these views. Escape returns to your choices. Wide terminals also show the preview beside the options. Narrow terminals show it below them.

Press n outside text editors to add a note. Enter or Escape saves the note. Notes do not count as choices. The Review tab allows partial answers and names unanswered questions. A note-only submission is allowed, but an empty submission is not.

Cancelling discards all draft answers. The questionnaire also closes when the agent aborts its request. Unanswered questions remain undecided.

In fullscreen Pi, click an option label or any line of its description to choose it or toggle its checkbox. Click `Type something.` to write a custom answer. Next, Submit, and the Review actions appear as plain clickable rows. Clicking Next or Submit saves custom text that you are still editing.

Click a question header or Review to switch tabs. Clicking another tab saves an open note and keeps custom-answer drafts. Page Up, Page Down, and the mouse wheel scroll the conversation while you answer. In regular mode, use keyboard navigation and your terminal's scrollback controls.
