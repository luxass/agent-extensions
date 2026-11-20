import type { SubagentManager } from "./manager.ts";

// Pi's terminal API writes only the root OSC 7501 record. Use a child record so
// Pi can report that its own turn finished or is blocked without hiding subagent work.
const SUBAGENT_STATUS_ID = "pi-subagents";
const CLEAR_SUBAGENTS = `\x1b]7501;state=clear:id=${SUBAGENT_STATUS_ID}\x1b\\`;

/** Reports running subagents to Rex independently of Pi's main turn. */
export function reportSubagentsToRex(manager: SubagentManager): (() => void) | undefined {
  if (
    !process.stdout.isTTY ||
    !process.env.REX_SESSION ||
    !process.env.REX_BLOCK ||
    process.env.PI_PROGRAM_STATUS === "0"
  ) {
    return undefined;
  }

  let reportedCount = 0;
  let pending = false;
  let disposed = false;
  let resend = false;

  const scheduleReport = () => {
    if (pending) return;
    pending = true;
    // The manager can finish one agent and start a queued one in the same turn.
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      const count = manager
        .list()
        .filter(({ status }) => status === "running" || status === "stopping").length;
      if (!resend && count === reportedCount) return;
      resend = false;
      reportedCount = count;
      if (count === 0) {
        process.stdout.write(CLEAR_SUBAGENTS);
        return;
      }
      const message = `${count} ${count === 1 ? "subagent" : "subagents"} running`;
      const encoded = Buffer.from(message).toString("base64");
      process.stdout.write(`\x1b]7501;state=working:id=${SUBAGENT_STATUS_ID}:msg=${encoded}\x1b\\`);
    });
  };
  const onResume = () => {
    // Pi clears all records when it suspends, even if the count stays the same.
    if (reportedCount === 0) return;
    resend = true;
    scheduleReport();
  };
  const unsubscribe = manager.subscribe(scheduleReport);
  process.on("SIGCONT", onResume);
  scheduleReport();

  return () => {
    disposed = true;
    unsubscribe();
    process.off("SIGCONT", onResume);
    if (reportedCount > 0) process.stdout.write(CLEAR_SUBAGENTS);
  };
}
