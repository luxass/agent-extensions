# @luxass/pi-questions

Let [Pi](https://github.com/badlogic/pi-mono) ask you structured questions with tabs, choices, notes, and Markdown previews instead of guessing your decisions.

## Install

```sh
pi install npm:@luxass/pi-questions
```

The package has no runtime dependencies of its own. It relies on the Pi and TypeBox packages that Pi already provides. There are no configuration files.

To try a local checkout instead, start Pi with the package directory:

```sh
pi -e ./packages/pi-questions
```

## Use

The model receives the `ask_user_question` tool and instructions to use it when a decision needs your input. You can also ask it to use the tool explicitly. It accepts one to four questions, with two to four options per question.

## Answer questions

The questionnaire opens in Pi's editor area, below the conversation, rather than in a centered popup. It uses the full editor width. Its height is capped at 70% of the terminal, with a 12-row minimum when space allows. The question and footer stay visible while options scroll to the focused row.

If a question is too long for the heading, a hint replaces its last visible line. Press q outside the text editors to read the complete question. Up, Down, Home, and End scroll the question. Escape returns to the choices without changing your answers.

Press Ctrl+] to collapse the questionnaire to one hint row. Press it again to expand. Answers, notes, editor drafts, and the current question stay intact. While collapsed, only expand and cancel can change the questionnaire.

With multiple questions, each question has a tab and a final Review tab shows your choices before submission. Selecting an option moves to the next tab. With one question, confirming an answer submits it directly.

| Key                 | Action                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| Tab or Right        | Move to the next tab in a multi-question dialog.                            |
| Shift+Tab or Left   | Move to the previous tab in a multi-question dialog.                        |
| Up or Down          | Move between choices.                                                       |
| Enter               | Choose an option, toggle a checkbox, or commit the custom answer.           |
| Space               | Toggle an authored checkbox. It does nothing on Next.                       |
| 1–4                 | Choose the corresponding authored option.                                   |
| n                   | Edit a question note, or a global note on the Review tab.                   |
| p                   | Read the focused option's Markdown preview in full.                         |
| q                   | Read the complete question. Up, Down, Home, and End scroll. Escape returns. |
| Ctrl+]              | Collapse or expand without losing answers or drafts.                        |
| Ctrl+U              | Clear the whole custom-answer draft while typing.                           |
| Page Up / Page Down | Leave these keys available for Pi's transcript scrolling.                   |
| Delete              | While browsing, clear the current answer without clearing its note.         |
| Escape              | Cancel, save a note, or return from a full question or preview.             |

For a multiple-choice question, select the checkboxes you want. Choose Next when you finish. Custom text is included with checked options, even after you browse away from its row.

Focus `Type something.` to type directly in its inline editor. The editor supports multiple lines and pasted text. Enter commits the answer, and Shift+Enter adds a line. At the first or last line, Up or Down returns to option navigation without losing the draft. An empty single-choice custom answer is not submitted. Escape cancels the whole questionnaire.

Press n outside the custom editor to add a note. Enter or Escape saves the note and returns to the question. On the Review tab, n adds a global note. Notes do not count as choices.

In fullscreen Pi, Page Up, Page Down, and the mouse wheel remain available to scroll the conversation while you answer. The questionnaire does not capture wheel events. In regular mode, use your terminal's scrollback controls.

Wide terminals show the focused option's preview beside the options. Narrow terminals show it below them. Press p to read a long preview in full within the editor area. Up, Down, Home, and End scroll that preview. Escape returns to the question. Previews support Markdown, fenced code, and ASCII mockups.

For multiple questions, choose Submit answers or Cancel questionnaire on the Review tab. Partial answers are allowed. The review names unanswered questions, and the result leaves those choices undecided. A note-only submission is allowed, but an empty submission is not.

Cancelling discards the questionnaire without sending draft answers. The tool also closes when the agent aborts its request.

## Tool parameters

````ts
ask_user_question({
  questions: [
    {
      header: "Approach",
      question: "Which approach do you prefer?",
      options: [
        {
          label: "Small change",
          description: "Keep the implementation focused.",
          preview: "```ts\nexport const enabled = true;\n```",
        },
        {
          label: "Full feature",
          description: "Include all planned behavior now.",
        },
      ],
      multiSelect: false,
    },
  ],
});
````

Headers have a 16-character limit. Option labels have a 60-character limit. Questions and option labels must be distinct, and visible text must not be blank. Do not author `Other`, `Type something.`, or `Next` options, in any casing or punctuation. The dialog supplies custom answers and navigation. Invalid calls return an `invalid_questions` error that names the failing fields, so the model can correct and retry.

The result contains submitted answers, chosen option labels, custom text, notes, and any unanswered question indexes. It is available as structured data and as model-readable text. Cancellation is separate from a UI or validation error. Tool calls run sequentially so that two questionnaires do not compete for input.

## Limits

The questionnaire requires interactive Pi. The tool is removed from the active tool list in non-interactive sessions, including RPC. It does not make model requests of its own. External editors, configurable collapse keys, and an event API are not supported.

A questionnaire stacks at the bottom only if another questionnaire owns the editor slot or another overlay is open. This prevents an invisible question from taking the keyboard. This fallback also collapses to one visible row. Normal questionnaires are inline, not overlays.

## License

[MIT](LICENSE).
