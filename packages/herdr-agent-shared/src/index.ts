import { stripVTControlCharacters } from "node:util";

import { type MetadataRequest, reportMetadata } from "./transport.ts";

const labelSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_LABEL_LENGTH = 200;

export interface HerdrBlockedReporterOptions {
  /** Unique metadata owner, for example "pi-questions:blocked". */
  source: string;
  /** Herdr agent ID, for example "pi" or "opencode". */
  agent: string;
  /** Apply labels only while this lifecycle reporter is authoritative. */
  appliesToSource?: string;
  /** Defaults to process.env. Only the injected Herdr pane and socket are used. */
  env?: Readonly<Record<string, string | undefined>>;
}

interface HerdrTarget {
  paneId: string;
  endpoint: string;
}

function normalizeLabel(label: string): string {
  const text = stripVTControlCharacters(label)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters: string[] = [];
  for (const { segment } of labelSegmenter.segment(text)) {
    characters.push(segment);
    if (characters.length === MAX_LABEL_LENGTH) break;
  }
  return characters.join("") || "Waiting for input";
}

/** Display-only blocked labels. The host integration still owns agent lifecycle state. */
export class HerdrBlockedReporter {
  private readonly source: string;
  private readonly agent: string;
  private readonly appliesToSource: string | undefined;
  private readonly target: HerdrTarget | undefined;
  private readonly reasons = new Map<symbol, string>();
  private sequence = Date.now() * 1_000;
  private lastLabel: string | undefined;
  private retryNeeded = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: HerdrBlockedReporterOptions) {
    if (!/^[A-Za-z0-9:._-]{1,80}$/u.test(options.source)) {
      throw new Error("Herdr metadata sources must use 1–80 ASCII letters, digits, :, ., _, or -.");
    }
    this.source = options.source;
    this.agent = options.agent;
    this.appliesToSource = options.appliesToSource;

    const env = options.env ?? process.env;
    const paneId = env.HERDR_PANE_ID;
    const socketPath = env.HERDR_SOCKET_PATH;
    if (env.HERDR_ENV === "1" && paneId && socketPath) {
      this.target = {
        paneId,
        endpoint:
          process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\")
            ? `\\\\.\\pipe\\${socketPath}`
            : socketPath,
      };
    }
  }

  /** Show a reason and return its idempotent release function. */
  block(label: string): () => Promise<void> {
    if (!this.target) return () => this.pending;
    const key = Symbol();
    this.reasons.set(key, normalizeLabel(label));
    void this.publish();
    return () => {
      if (!this.reasons.delete(key)) return this.pending;
      return this.publish();
    };
  }

  /** Clear this reporter's reasons and wait for outstanding delivery attempts. */
  clear(): Promise<void> {
    this.reasons.clear();
    return this.publish();
  }

  private publish(): Promise<void> {
    const target = this.target;
    if (!target) return this.pending;
    const label = [...this.reasons.values()].at(-1);
    if (label === this.lastLabel && !this.retryNeeded) return this.pending;
    this.lastLabel = label;
    this.retryNeeded = false;
    this.sequence = Math.max(this.sequence + 1, Date.now() * 1_000);
    const request: MetadataRequest = {
      id: `${this.source}:${this.sequence}`,
      method: "pane.report_metadata",
      params: {
        pane_id: target.paneId,
        source: this.source,
        agent: this.agent,
        applies_to_source: this.appliesToSource,
        ...(label ? { state_labels: { blocked: label } } : { clear_state_labels: true }),
        seq: this.sequence,
      },
    };
    // Keep updates ordered, including clears and retries after a lost acknowledgement.
    this.pending = this.pending.then(async () => {
      const delivered = await reportMetadata(target.endpoint, request);
      if (request.params.seq === this.sequence) this.retryNeeded = !delivered;
    });
    return this.pending;
  }
}
