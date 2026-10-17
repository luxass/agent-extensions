import type { LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

export function captureResourceLoader(command: string) {
  let readLoader: (() => ResourceLoader) | undefined;
  const prototype = DefaultResourceLoader.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- The interceptor supplies the original receiver with call(this).
  const original = prototype.getExtensions;

  function restore() {
    if (prototype.getExtensions === intercept) prototype.getExtensions = original;
  }

  function intercept(this: DefaultResourceLoader): LoadExtensionsResult {
    const result = original.call(this);
    if (result.extensions.some((extension) => extension.commands.has(command))) {
      readLoader = () => this;
      restore();
    }
    return result;
  }

  // Unsupported bridge: Pi reads this list after loading extensions to build its runtime.
  // Capture that loader once, then leave the shared prototype unchanged.
  prototype.getExtensions = intercept;

  return {
    read: () => readLoader?.(),
    dispose: restore,
  };
}
