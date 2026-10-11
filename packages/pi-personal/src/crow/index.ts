/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login`:
 * 1. Provider is registered as OAuth-only so `/login Crow` / `/login crow`
 *    skip the API-key vs account selector and go straight to multi-field prompts
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login Crow` or `/login crow`.
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 5. On success, models are registered immediately; Pi saves credentials in auth.json.

 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Credentials live in auth.json. Non-interactive setup uses upstream env vars.
 */

import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ProviderModelConfig,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { ProactiveCompactionController } from "./auto-compact.ts";
import {
  CLIPROXYAPI_CODEX_API,
  type CliproxyCodexStreamSimple,
  loadCliproxyCodexStreams,
} from "./codex-stream.ts";
import {
  CREDENTIAL_TTL_MS,
  DEFAULT_BASE_URL,
  decodeRefreshMeta,
  encodeRefreshMeta,
  firstNonEmpty,
  loadAuthConnection,
  loadMappedModels,
  type MappedModels,
  resolveConnection,
  resolveEndpoints,
  resolveIdentity,
} from "./lib.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";

interface RefreshResult {
  modelCount: number;
  modelsUrl: string;
}

export const DEFAULT_AUTO_RECOVERY_DELAY_MS = 60_000;
export const MAX_AUTO_RECOVERY_DELAY_MS = 300_000;

export interface RecoverySnapshot {
  action: () => Promise<unknown>;
  attempt: number;
  delayMs: number;
}

class ModelRefreshCoordinator {
  private generation = 0;
  private activeController: AbortController | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryAttempt = 0;
  private activeRecovery: RecoverySnapshot | undefined;
  private stopped = false;

  begin(): { generation: number; signal: AbortSignal } {
    this.clearRecoveryTimer();
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    this.generation += 1;
    return { generation: this.generation, signal: controller.signal };
  }

  isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  scheduleRecovery(
    action: () => Promise<unknown>,
    baseDelayMs = DEFAULT_AUTO_RECOVERY_DELAY_MS,
    maxDelayMs = MAX_AUTO_RECOVERY_DELAY_MS,
  ): void {
    if (this.stopped) return;
    this.clearRecoveryTimer();
    const delay = Math.min(baseDelayMs * 1.5 ** this.recoveryAttempt, maxDelayMs);
    this.recoveryAttempt += 1;
    this.activeRecovery = { action, attempt: this.recoveryAttempt, delayMs: delay };

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.stopped) return;
      void action().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("is stale after session replacement or reload")) {
          this.clearRecovery();
          return;
        }
        // Suppressed: logging this into the TUI corrupts the display.
        // The refresh path already reschedules the next attempt.
      });
    }, delay);
    this.recoveryTimer.unref?.();
  }

  snapshotRecovery(): RecoverySnapshot | undefined {
    if (!this.stopped && this.activeRecovery) {
      return { ...this.activeRecovery };
    }
    return undefined;
  }

  restoreRecovery(snapshot: RecoverySnapshot): void {
    if (this.stopped || !snapshot) return;
    this.clearRecoveryTimer();
    this.recoveryAttempt = snapshot.attempt;
    this.activeRecovery = snapshot;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.stopped) return;
      void snapshot.action().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("is stale after session replacement or reload")) {
          this.clearRecovery();
          return;
        }
        // Suppressed: logging this into the TUI corrupts the display.
        // The refresh path already reschedules the next attempt.
      });
    }, snapshot.delayMs);
    this.recoveryTimer.unref?.();
  }

  clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  clearRecovery(): void {
    this.clearRecoveryTimer();
    this.recoveryAttempt = 0;
    this.activeRecovery = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.clearRecovery();
    this.activeController?.abort();
    this.activeController = undefined;
    this.generation += 1;
  }
}

const COMPAT_COORDINATOR_KEY = Symbol.for("pi-cliproxyapi-provider.compat-coordinator");
export const COMPAT_SOURCE_ID = "pi-cliproxyapi-provider-global";

interface CompatRegistrationEntry {
  instanceId: string;
  providerId: string;
  rawStream: CliproxyCodexStreamSimple;
  rawStreamSimple: CliproxyCodexStreamSimple;
}

function getCompatCoordinator() {
  const globalState = globalThis as typeof globalThis & {
    [COMPAT_COORDINATOR_KEY]?: { stack: CompatRegistrationEntry[] };
  };
  if (!globalState[COMPAT_COORDINATOR_KEY]) {
    globalState[COMPAT_COORDINATOR_KEY] = { stack: [] };
  }
  return globalState[COMPAT_COORDINATOR_KEY];
}

export function resetCompatCoordinator(): void {
  const coordinator = getCompatCoordinator();
  coordinator.stack = [];
}

function findActiveCompatEntry(
  stack: CompatRegistrationEntry[],
  providerId: string,
): CompatRegistrationEntry | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry?.providerId === providerId) {
      return entry;
    }
  }
  return undefined;
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
  try {
    return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
  } catch {
    return false;
  }
}

function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
  return {
    refresh: encodeRefreshMeta(baseUrlInput),
    access: apiKey,
    expires: Date.now() + CREDENTIAL_TTL_MS,
  };
}

function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
  const authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
  return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, authBaseUrl, DEFAULT_BASE_URL)!;
}

async function promptConnection(
  callbacks: OAuthLoginCallbacks,
  defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
  callbacks.onProgress?.(
    "Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).",
  );

  const baseUrlRaw = await callbacks.onPrompt({
    message: `Crow base URL [${defaults.baseUrl}]:`,
    placeholder: defaults.baseUrl,
    allowEmpty: true,
  });
  const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

  // Validate early so users get a clear error before typing the API key.
  resolveEndpoints(baseUrlInput);

  const apiKey = (
    await callbacks.onPrompt({
      message: "Crow API key:",
      placeholder: "sk-...",
      allowEmpty: false,
    })
  ).trim();

  if (!apiKey) {
    throw new Error("API key cannot be empty.");
  }

  return { baseUrlInput, apiKey };
}

async function configureAndRegister(options: {
  pi: ExtensionAPI;
  agentDir: string;
  providerId: string;
  providerName: string;
  baseUrlInput: string;
  apiKey: string;
  defaultBaseUrl: string;
  streamSimple: CliproxyCodexStreamSimple;
  refreshCoordinator: ModelRefreshCoordinator;
  onRefreshOutcome?: (loaded: MappedModels) => void;
}): Promise<RefreshResult> {
  const {
    pi,
    agentDir,
    providerId,
    providerName,
    baseUrlInput,
    apiKey,
    defaultBaseUrl,
    streamSimple,
    refreshCoordinator,
    onRefreshOutcome,
  } = options;

  const refresh = refreshCoordinator.begin();
  const loaded = await loadMappedModels(baseUrlInput, apiKey, undefined, agentDir, refresh.signal);
  if (!refreshCoordinator.isCurrent(refresh.generation)) {
    throw new Error("Model refresh was superseded by a newer request.");
  }

  // /login stores oauth credentials itself; keep the provider OAuth-only so
  // `/login <provider>` skips the API-key vs account selector.
  registerProvider(pi, {
    providerId,
    providerName,
    baseUrlInput,
    models: loaded.models,
    defaultBaseUrl: baseUrlInput || defaultBaseUrl,
    agentDir,
    streamSimple,
    refreshCoordinator,
    onRefreshOutcome,
  });

  onRefreshOutcome?.(loaded);

  return {
    modelCount: loaded.models.length,
    modelsUrl: loaded.modelsUrl,
  };
}

function createOAuthHandlers(options: {
  pi: ExtensionAPI;
  agentDir: string;
  providerId: string;
  providerName: string;
  defaultBaseUrl: string;
  streamSimple: CliproxyCodexStreamSimple;
  refreshCoordinator: ModelRefreshCoordinator;
  onRefreshOutcome?: (loaded: MappedModels) => void;
}) {
  const {
    pi,
    agentDir,
    providerId,
    providerName,
    defaultBaseUrl,
    streamSimple,
    refreshCoordinator,
    onRefreshOutcome,
  } = options;

  return {
    name: providerName,

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      let promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

      // Final login step: validate by calling /v1/models.
      // HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
      while (true) {
        const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
          baseUrl: promptDefaultBaseUrl,
        });

        callbacks.onProgress?.("Validating credentials via models endpoint...");
        const previousRecovery = refreshCoordinator.snapshotRecovery();
        try {
          const result = await configureAndRegister({
            pi,
            agentDir,
            providerId,
            providerName,
            baseUrlInput,
            apiKey,
            defaultBaseUrl,
            streamSimple,
            refreshCoordinator,
            onRefreshOutcome,
          });

          process.stderr.write(
            `${JSON.stringify({
              source: "pi-cliproxyapi-provider",
              level: "info",
              message: `login ok: registered ${result.modelCount} models from ${result.modelsUrl}`,
            })}\n`,
          );
          return buildOAuthCredentials(baseUrlInput, apiKey);
        } catch (error) {
          if (previousRecovery) {
            refreshCoordinator.restoreRecovery(previousRecovery);
          }
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `${JSON.stringify({ source: "pi-cliproxyapi-provider", level: "warning", message: `login validation failed: ${message}` })}\n`,
          );
          callbacks.onProgress?.(
            `Login validation failed: ${message}\nPlease re-enter base URL and API key.`,
          );
          // Keep last baseUrl as the next default so retyping is easier.
          promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
        }
      }
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      // API keys do not expire; keep the stored payload as-is.
      return {
        ...credentials,
        expires: Date.now() + CREDENTIAL_TTL_MS,
      };
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },

    modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
      const meta = decodeRefreshMeta(credentials.refresh);
      if (!meta?.baseUrl) {
        return models;
      }
      try {
        const { inferenceBaseUrl } = resolveEndpoints(meta.baseUrl);
        return models.map((model) =>
          model.provider === providerId ? { ...model, baseUrl: inferenceBaseUrl } : model,
        );
      } catch {
        return models;
      }
    },
  };
}

function registerProvider(
  pi: ExtensionAPI,
  options: {
    providerId: string;
    providerName: string;
    baseUrlInput: string;
    apiKey?: string;
    models?: ProviderModelConfig[];
    defaultBaseUrl: string;
    agentDir: string;
    streamSimple: CliproxyCodexStreamSimple;
    refreshCoordinator?: ModelRefreshCoordinator;
    onRefreshOutcome?: (loaded: MappedModels) => void;
  },
): void {
  const {
    providerId,
    providerName,
    baseUrlInput,
    apiKey,
    models,
    defaultBaseUrl,
    agentDir,
    streamSimple,

    onRefreshOutcome,
  } = options;
  const refreshCoordinator = options.refreshCoordinator ?? new ModelRefreshCoordinator();

  const endpoints = resolveEndpoints(baseUrlInput);
  let currentModels = models;
  let checkedAt = models ? Date.now() : undefined;
  const oauth = createOAuthHandlers({
    pi,
    agentDir,
    providerId,
    providerName,
    defaultBaseUrl,
    streamSimple,
    refreshCoordinator,
    onRefreshOutcome,
  });

  // Replace any previous registration so an earlier ambient apiKey does not linger
  // via registerProvider merge semantics and reintroduce the auth-type selector.
  pi.unregisterProvider(providerId);

  pi.registerProvider(providerId, {
    name: providerName,
    baseUrl: endpoints.inferenceBaseUrl,
    api: CLIPROXYAPI_CODEX_API,
    streamSimple,
    // OAuth-only keeps `/login <provider>` on the multi-field account path.
    // Pass apiKey only for ambient request auth when no /login credential exists
    // (env). Never pass both for /login flows.
    oauth,
    ...(apiKey ? { apiKey } : {}),
    ...(models ? { models } : {}),
    async refreshModels(context) {
      let catalog =
        currentModels ??
        context.stored?.models.filter(
          (model): model is Model<Api> =>
            "reasoning" in model &&
            model.provider === providerId &&
            model.baseUrl === endpoints.inferenceBaseUrl,
        );
      let catalogCheckedAt = checkedAt ?? context.stored?.checkedAt;
      if (context.allowNetwork) {
        const connection = resolveConnection(agentDir, providerId);
        if (connection) {
          const loaded = await loadMappedModels(
            connection.baseUrlInput,
            connection.apiKey,
            undefined,
            agentDir,
            context.signal,
          );
          catalog = loaded.models;
          catalogCheckedAt = Date.now();
        }
      }
      if (!catalog || context.signal.aborted) return [];
      const published = await context.publish({
        persist: {
          models: catalog.map((model) => ({
            ...model,
            api: CLIPROXYAPI_CODEX_API,
            provider: providerId,
            baseUrl: endpoints.inferenceBaseUrl,
          })),
          checkedAt: catalogCheckedAt,
        },
      });
      if (published) {
        currentModels = catalog;
        checkedAt = catalogCheckedAt;
      }
      return catalog;
    },
  });
}

export function registerRefreshCommand(options: {
  pi: ExtensionAPI;
  agentDir: string;
  providerId: string;
  providerName: string;
  defaultBaseUrl: string;
  streamSimple: CliproxyCodexStreamSimple;
  refreshCoordinator?: ModelRefreshCoordinator;
  onRefresh?: (
    connection: NonNullable<ReturnType<typeof resolveConnection>>,
  ) => Promise<RefreshResult | undefined>;
}): void {
  const {
    pi,
    agentDir,
    providerId,
    providerName,
    defaultBaseUrl,
    streamSimple,
    refreshCoordinator,
    onRefresh,
  } = options;

  pi.registerCommand("cliproxyapi-refresh", {
    description: "Force refresh CLIProxyAPI models from the remote catalog.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
        return;
      }

      const connection = resolveConnection(agentDir, providerId);
      if (!connection) {
        ctx.ui.notify(
          `CLIProxyAPI is not configured. Use /login ${providerName} or /login ${providerId}.`,
          "error",
        );
        return;
      }

      try {
        let result: RefreshResult | undefined;
        if (onRefresh) {
          result = await onRefresh(connection);
          if (!result) return;
        } else {
          const refresh = refreshCoordinator?.begin();
          const loaded = await loadMappedModels(
            connection.baseUrlInput,
            connection.apiKey,
            undefined,
            agentDir,
            refresh?.signal,
          );
          if (refresh && !refreshCoordinator?.isCurrent(refresh.generation)) return;

          const hasStoredLogin = hasLoginCredential(agentDir, providerId);
          registerProvider(pi, {
            providerId,
            providerName,
            baseUrlInput: connection.baseUrlInput,
            apiKey: hasStoredLogin ? undefined : connection.apiKey,
            models: loaded.models,
            defaultBaseUrl,
            agentDir,
            streamSimple,
            refreshCoordinator,
          });

          result = {
            modelCount: loaded.models.length,
            modelsUrl: loaded.modelsUrl,
          };
        }

        ctx.ui.notify(
          `Refreshed ${result.modelCount} CLIProxyAPI models from ${result.modelsUrl}.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
      }
    },
  });
}

export { CLIPROXYAPI_CODEX_API } from "./codex-stream.ts";
export { resolveEndpoints, toPiModel } from "./lib.ts";

export default async function crow(pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const identity = resolveIdentity();
  const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

  const proactiveCompaction = new ProactiveCompactionController(agentDir, identity.providerId);
  proactiveCompaction.register(pi);

  const modelRefreshCoordinator = new ModelRefreshCoordinator();

  let streamSimple: CliproxyCodexStreamSimple = () => {
    throw new Error(
      `Codex protocol stream is unavailable for provider: ${identity.providerId} (api: ${CLIPROXYAPI_CODEX_API})`,
    );
  };
  try {
    const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"]);
    proactiveCompaction.setCloseWebSocketSessions(streams.closeOpenAICodexWebSocketSessions);
    streamSimple = proactiveCompaction.wrapStreamSimple(streams.streamSimple);

    pi.on("session_shutdown", () => {
      try {
        streams.closeOpenAICodexWebSocketSessions();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `${JSON.stringify({
            source: "pi-cliproxyapi-provider",
            level: "warning",
            message: `failed to close Codex WebSocket sessions on shutdown: ${message}`,
          })}\n`,
        );
      }
    });

    try {
      const { registerApiProvider, unregisterApiProviders } =
        await import("@earendil-works/pi-ai/compat");

      const coordinator = getCompatCoordinator();
      const instanceId = `${identity.providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const entry: CompatRegistrationEntry = {
        instanceId,
        providerId: identity.providerId,
        rawStream: streams.rawStream,
        rawStreamSimple: streams.rawStreamSimple,
      };

      coordinator.stack.push(entry);

      const dispatchStream: CliproxyCodexStreamSimple = (model, context, options) => {
        const active = findActiveCompatEntry(coordinator.stack, model.provider);
        if (!active) {
          throw new Error(
            `No active provider stream handler registered for provider: ${model.provider} (api: ${CLIPROXYAPI_CODEX_API})`,
          );
        }

        return active.rawStream(model, context, options);
      };

      const dispatchStreamSimple: CliproxyCodexStreamSimple = (model, context, options) => {
        const active = findActiveCompatEntry(coordinator.stack, model.provider);
        if (!active) {
          throw new Error(
            `No active provider streamSimple handler registered for provider: ${model.provider} (api: ${CLIPROXYAPI_CODEX_API})`,
          );
        }

        return active.rawStreamSimple(model, context, options);
      };

      unregisterApiProviders(COMPAT_SOURCE_ID);
      registerApiProvider(
        {
          api: CLIPROXYAPI_CODEX_API,
          stream: dispatchStream,
          streamSimple: dispatchStreamSimple,
        },
        COMPAT_SOURCE_ID,
      );

      pi.on("session_shutdown", () => {
        const index = coordinator.stack.findIndex((item) => item.instanceId === instanceId);
        if (index !== -1) {
          coordinator.stack.splice(index, 1);
        }
        if (coordinator.stack.length === 0) {
          unregisterApiProviders(COMPAT_SOURCE_ID);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({
          source: "pi-cliproxyapi-provider",
          level: "warning",
          message: `failed to register compat API provider: ${message}`,
        })}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({
        source: "pi-cliproxyapi-provider",
        level: "warning",
        message: `failed to load patched codex protocol: ${message}`,
      })}\n`,
    );
  }

  const scheduleActiveRecovery = (): void => {
    modelRefreshCoordinator.scheduleRecovery(async () => {
      const activeConn = resolveConnection(agentDir, identity.providerId);
      if (!activeConn) {
        modelRefreshCoordinator.clearRecovery();
        return;
      }
      await registerConfiguredProvider(activeConn, { forceRefresh: true });
    }, DEFAULT_AUTO_RECOVERY_DELAY_MS);
  };

  const handleRefreshOutcome = (): void => modelRefreshCoordinator.clearRecovery();

  // Always register oauth so the provider is visible in /login immediately after install.
  registerProvider(pi, {
    providerId: identity.providerId,
    providerName: identity.providerName,
    baseUrlInput: defaultBaseUrl,
    defaultBaseUrl,
    agentDir,
    streamSimple,
    refreshCoordinator: modelRefreshCoordinator,
    onRefreshOutcome: handleRefreshOutcome,
  });
  registerTransientNetworkErrorRetry(pi, identity.providerId);

  pi.on("session_start", async (_event, ctx) => {
    const result = await ctx.modelRegistry.refresh({
      allowNetwork: true,
      providers: [identity.providerId],
    });
    const error = result.errors.get(identity.providerId);
    if (error) {
      process.stderr.write(
        `${JSON.stringify({
          source: "pi-cliproxyapi-provider",
          level: "warning",
          message: `failed to refresh models (${error.message}); keeping Pi's stored catalog.`,
        })}\n`,
      );
      scheduleActiveRecovery();
    }
  });
  pi.on("session_shutdown", () => {
    modelRefreshCoordinator.stop();
  });

  const registerConfiguredProvider = async (
    currentConnection: { baseUrlInput: string; apiKey: string },
    options: { forceRefresh?: boolean } = {},
  ): Promise<RefreshResult | undefined> => {
    const refresh = modelRefreshCoordinator.begin();
    try {
      const loaded = await loadMappedModels(
        currentConnection.baseUrlInput,
        currentConnection.apiKey,
        undefined,
        agentDir,
        refresh.signal,
      );
      if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;

      // Prefer OAuth-only registration when /login already stored credentials so
      // `/login <provider>` jumps straight into the multi-field flow. Fall back to
      // ambient apiKey only for env setups without auth.json.
      const hasStoredLogin = hasLoginCredential(agentDir, identity.providerId);
      registerProvider(pi, {
        providerId: identity.providerId,
        providerName: identity.providerName,
        baseUrlInput: currentConnection.baseUrlInput,
        apiKey: hasStoredLogin ? undefined : currentConnection.apiKey,
        models: loaded.models,
        defaultBaseUrl,
        agentDir,
        streamSimple,
        refreshCoordinator: modelRefreshCoordinator,
        onRefreshOutcome: handleRefreshOutcome,
      });

      handleRefreshOutcome();

      return {
        modelCount: loaded.models.length,
        modelsUrl: loaded.modelsUrl,
      };
    } catch (error) {
      if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("is stale after session replacement or reload")) {
        modelRefreshCoordinator.clearRecovery();
        return undefined;
      }
      if (options.forceRefresh) {
        scheduleActiveRecovery();
      }
      throw error;
    }
  };

  registerRefreshCommand({
    pi,
    agentDir,
    providerId: identity.providerId,
    providerName: identity.providerName,
    defaultBaseUrl,
    streamSimple,
    refreshCoordinator: modelRefreshCoordinator,
    onRefresh: (currentConnection) =>
      registerConfiguredProvider(currentConnection, { forceRefresh: true }),
  });
}
