import { Plugin } from "@opencode/plugin";

import crow from "./crow/index.ts";
import dependencyPolicy from "./dependency-policy.ts";
import gitInterceptor from "./git-interceptor.ts";
import packageManagerInterceptor from "./package-manager-interceptor.ts";
import workerConfigurationGuard from "./worker-configuration-guard.ts";

export const id = "opencode-personal";
const plugins: readonly Plugin.Plugin[] = [
  crow,
  dependencyPolicy,
  gitInterceptor,
  packageManagerInterceptor,
  workerConfigurationGuard,
];

export default Plugin.define({
  id: id,
  async setup(ctx) {
    const cleanups: Plugin.Cleanup[] = [];

    async function dispose(): Promise<void> {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `Failed to clean up ${id}`);
    }

    try {
      for (const plugin of plugins) {
        const cleanup = await plugin.setup(ctx);
        if (cleanup) cleanups.push(cleanup);
      }
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to set up ${id}`, {
          cause: cleanupError,
        });
      }
      throw error;
    }

    return dispose;
  },
});
