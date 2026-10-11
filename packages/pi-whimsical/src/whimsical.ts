import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { codingMessages } from "./messages/coding.js";
import { domesticMessages } from "./messages/domestic.js";
import { fantasyMessages } from "./messages/fantasy.js";
import { functionalMessages } from "./messages/functional.js";
import { memesMessages } from "./messages/memes.js";
import { nonsenseMessages } from "./messages/nonsense.js";
import {
  SPECIAL_GENERAL_KENOBI,
  SPECIAL_HELLO_THERE,
  starWarsMessages,
} from "./messages/star-wars.js";
import { verbsMessages } from "./messages/verbs.js";

const workingMessages = [
  ...verbsMessages,
  ...nonsenseMessages,
  ...functionalMessages,
  ...codingMessages,
  ...fantasyMessages,
  ...domesticMessages,
  ...memesMessages,
  ...starWarsMessages,
];

export default function (pi: ExtensionAPI): void {
  let wasHelloThere = false;

  pi.on("session_start", () => {
    wasHelloThere = false;
  });

  pi.on("turn_start", (_event, ctx) => {
    const message = wasHelloThere
      ? SPECIAL_GENERAL_KENOBI
      : workingMessages[Math.floor(Math.random() * workingMessages.length)];

    wasHelloThere = message === SPECIAL_HELLO_THERE;
    ctx.ui.setWorkingMessage(message);
  });

  pi.on("agent_end", (_event, ctx) => {
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    wasHelloThere = false;
    ctx.ui.setWorkingMessage();
  });
}
