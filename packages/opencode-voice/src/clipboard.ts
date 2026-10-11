import { spawn } from "node:child_process";

export function copyToClipboard(text: string): Promise<void> {
  const [command, args] = ((): [string, string[]] => {
    switch (process.platform) {
      case "darwin":
        return ["pbcopy", []];
      case "linux":
        return process.env.WAYLAND_DISPLAY
          ? ["wl-copy", []]
          : ["xclip", ["-selection", "clipboard"]];
      case "win32":
        return [
          "powershell.exe",
          ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
        ];
      default:
        throw new Error(`Clipboard is unsupported on ${process.platform}`);
    }
  })();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Clipboard command exited (${code})`));
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
}
