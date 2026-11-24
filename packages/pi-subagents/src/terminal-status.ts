import type { SubagentManager } from "./manager.ts";

// Pi's terminal API writes only the root OSC 7501 record. Use child records so
// Pi can report that its own turn finished or is blocked without hiding subagent work.
const SUBAGENT_STATUS_NAMESPACE = "pi-subagents";
const OSC_TITLE_MAX_BYTES = 192;

function clearRexStatus(id: string): string {
  return `\x1b]7501;state=clear:id=${id}\x1b\\`;
}

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

  let reported = new Map<string, "running" | "stopping">();
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

      const active = new Map<string, "running" | "stopping">();
      let updates = "";
      for (const { id, name, status } of manager.list()) {
        if (status !== "running" && status !== "stopping") continue;
        // A UUID without hyphens fits the OSC limit of 32 bytes per ID segment.
        const statusId = `${SUBAGENT_STATUS_NAMESPACE}/${id.replaceAll("-", "")}`;
        active.set(statusId, status);
        if (!resend && reported.get(statusId) === status) continue;
        // Task names are ASCII and have no length limit. Shorten only the title sent to Rex.
        const title = Buffer.from(name.slice(0, OSC_TITLE_MAX_BYTES)).toString("base64");
        const message = Buffer.from(status === "running" ? "Running" : "Stopping").toString(
          "base64",
        );
        updates += `\x1b]7501;state=working:id=${statusId}:title=${title}:msg=${message}\x1b\\`;
      }

      let clears = "";
      for (const id of reported.keys()) {
        if (!active.has(id)) clears += clearRexStatus(id);
      }
      reported = active;
      resend = false;
      if (clears || updates) process.stdout.write(clears + updates);
    });
  };
  const onResume = () => {
    // Pi clears all records when it suspends. Resend even if no status changed.
    resend = true;
    scheduleReport();
  };
  const unsubscribe = manager.subscribe(scheduleReport);
  process.on("SIGCONT", onResume);
  scheduleReport();

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    process.off("SIGCONT", onResume);
    process.stdout.write(clearRexStatus(SUBAGENT_STATUS_NAMESPACE));
  };
}
