import { Integration, Plugin, Provider, type Model } from "@opencode/plugin";

import {
  BASE_URL_FIELD,
  DEFAULT_BASE_URL,
  fetchModels,
  PROVIDER_ID,
  resolveBaseURL,
} from "./lib.ts";

export default Plugin.define({
  id: "crow",
  async setup(ctx) {
    const cleanups: Plugin.Cleanup[] = [];
    const lifetime = new AbortController();
    let request = new AbortController();
    let refreshing = Promise.resolve();
    let watching: Promise<void> | undefined;
    let connection: Awaited<ReturnType<typeof ctx.integration.connection.active>>;
    let available: Model.Info[] = [];
    let known: readonly Model.Info[] = [];
    let baseURL = resolveBaseURL(process.env.CLIPROXYAPI_BASE_URL ?? DEFAULT_BASE_URL);

    async function discover(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const source = await ctx.integration.connection.active(PROVIDER_ID);
      const credential = source && (await ctx.integration.connection.resolve(source));
      signal.throwIfAborted();

      connection = undefined;
      available = [];
      await ctx.provider.reload();
      if (credential?.type !== "key") return;

      const savedURL = credential.configuration?.[BASE_URL_FIELD] as string | undefined;
      const url = resolveBaseURL(process.env.CLIPROXYAPI_BASE_URL ?? savedURL ?? DEFAULT_BASE_URL);
      const models = await fetchModels(url, credential.key, signal, known);
      signal.throwIfAborted();

      connection = source;
      available = models;
      baseURL = url;
      await ctx.provider.reload();
    }

    function refresh(): Promise<void> {
      request.abort();
      request = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      refreshing = discover(signal).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
      return refreshing;
    }

    function refreshAutomatically(): Promise<void> {
      return refresh().catch((error: unknown) =>
        console.error("[crow] Model refresh failed", error),
      );
    }

    async function dispose(): Promise<void> {
      lifetime.abort();
      request.abort();
      await Promise.allSettled([refreshing, watching]);
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Failed to clean up Crow");
    }

    try {
      const integration = await ctx.integration.transform((editor) => {
        editor.update(PROVIDER_ID, (info) => {
          info.name = "Crow";
        });
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: {
            type: "key",
            label: "Crow API key",
            form: [
              {
                type: "string",
                key: BASE_URL_FIELD,
                title: "Crow base URL",
                required: true,
                default: process.env.CLIPROXYAPI_BASE_URL ?? DEFAULT_BASE_URL,
              },
            ],
          },
        });
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { type: "env", names: ["CLIPROXYAPI_API_KEY"] },
        });
      });
      cleanups.push(() => integration.dispose());

      const provider = await ctx.provider.transform((editor) => {
        known = editor
          .list()
          .filter((entry) => entry.provider.id !== PROVIDER_ID)
          .flatMap((entry) => Array.from(entry.models.values()));
        editor.add({
          info: {
            id: PROVIDER_ID,
            name: "Crow",
            integrationID: Integration.ID.make(PROVIDER_ID),
            canonical: Provider.ID.openai,
            activation: "auto",
            package: "@opencode/ai/providers/openai/responses",
            settings: { baseURL },
            body: { store: false },
            transport: "http",
            compaction: { mode: "local" },
          },
          models: available,
          sourceConnection: connection,
        });
      });
      cleanups.push(() => provider.dispose());

      const command = await ctx.command.transform((editor) => {
        editor.add({
          name: "cliproxyapi-refresh",
          description: "Refresh Crow models from CPA",
          execute: refresh,
        });
      });
      cleanups.push(() => command.dispose());

      watching = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
            if (event.type === "credential.updated" || event.type === "credential.switched") {
              void refreshAutomatically();
            }
          }
        } catch (error) {
          if (!lifetime.signal.aborted)
            console.error("[crow] Credential subscription failed", error);
        }
      })();
      await refreshAutomatically();
      return dispose;
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Failed to set up Crow", {
          cause: cleanupError,
        });
      }
      throw error;
    }
  },
});
