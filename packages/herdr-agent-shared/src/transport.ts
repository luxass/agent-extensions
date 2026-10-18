import { createConnection } from "node:net";

const MAX_RESPONSE_LENGTH = 64 * 1_024;

export interface MetadataRequest {
  id: string;
  method: "pane.report_metadata";
  params: {
    pane_id: string;
    source: string;
    agent: string;
    applies_to_source?: string;
    state_labels?: { blocked: string };
    clear_state_labels?: true;
    seq: number;
  };
}

interface MetadataResponse {
  id: string;
  result?: { type: "ok" };
  error?: { code: string; message: string };
}

function sendAttempt(
  endpoint: string,
  request: MetadataRequest,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: endpoint, signal: AbortSignal.timeout(timeoutMs) });
    let response = "";

    function finish(delivered: boolean): void {
      resolve(delivered);
      socket.destroy();
    }

    socket.setEncoding("utf8");
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
    socket.once("close", () => resolve(false));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > MAX_RESPONSE_LENGTH) {
        finish(false);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(response.slice(0, newline)) as MetadataResponse | null;
        finish(
          envelope?.id === request.id &&
            envelope.result?.type === "ok" &&
            envelope.error === undefined,
        );
      } catch {
        finish(false);
      }
    });
  }).catch(() => false);
}

export async function reportMetadata(endpoint: string, request: MetadataRequest): Promise<boolean> {
  if (await sendAttempt(endpoint, request, 500)) return true;
  // Reuse the sequence so an accepted report with a lost response is safe to retry.
  return sendAttempt(endpoint, request, 1_500);
}
