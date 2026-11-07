import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error(`Invalid resource name: ${JSON.stringify(value)}`);
  return value;
}

export function contained(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** Size limit for definitions, settings, skills, and memory files. */
export const maxResourceBytes = 1_048_576;

export async function readText(path: string, limit = maxResourceBytes): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error(`Expected a regular file of at most ${limit} bytes: ${path}`);
    let buffer = Buffer.alloc(Math.min(info.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
      // A file can grow after stat; keep reading up to the limit plus one byte.
      if (length === buffer.length && length <= limit) {
        const expanded = Buffer.alloc(Math.min(limit + 1, buffer.length * 2));
        buffer.copy(expanded);
        buffer = expanded;
      }
    }
    if (length > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readObject(path: string): Promise<Record<string, unknown>> {
  let input: string;
  try {
    input = await readText(path);
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const value: unknown = JSON.parse(input);
  if (!record(value))
    throw new Error(`Expected an object in ${path}; repair or move the file before saving.`);
  return value;
}

/**
 * Replace a regular file atomically, preserving its mode and the old file on failure.
 * Symlink targets are refused rather than replacing the link or bypassing caller path checks.
 * There is no cross-process lock: concurrent writers of one file use last-writer-wins.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
  if (existing?.isSymbolicLink())
    throw new Error(`Refusing to replace a symbolic link: ${path}. Edit its real target instead.`);
  if (existing && !existing.isFile())
    throw new Error(`Expected a regular file destination: ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      if (existing) await file.chmod(existing.mode & 0o7777);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export async function checkedFile(resource: { root: string; file: string }): Promise<string> {
  const root = await realpath(resource.root);
  const file = await realpath(resource.file);
  if (!contained(root, file)) throw new Error(`Resource escapes its root: ${resource.file}`);
  const info = await stat(file);
  if (!info.isFile() || info.size > maxResourceBytes)
    throw new Error(`Resource must be a file no larger than 1 MiB: ${file}`);
  return readText(file);
}

/** Verify existing ancestors too, so a symlink cannot redirect a newly created directory. */
export async function safeDestination(root: string, path: string): Promise<void> {
  if (!contained(root, path)) throw new Error(`Unsafe destination: ${path}`);
  let ancestor = path;
  for (;;) {
    try {
      const target = await realpath(ancestor);
      let rootAncestor = root;
      for (;;) {
        try {
          const canonicalRoot = await realpath(rootAncestor);
          if (!contained(canonicalRoot, target))
            throw new Error(`Destination escapes its root: ${path}`);
          return;
        } catch (error) {
          if (!isMissing(error)) throw error;
          const parent = dirname(rootAncestor);
          if (parent === rootAncestor) throw error;
          rootAncestor = parent;
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
