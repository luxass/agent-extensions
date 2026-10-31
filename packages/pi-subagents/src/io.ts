import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

export async function readText(path: string, limit = 1_048_576): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error(`Expected a regular file of at most ${limit} bytes: ${path}`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
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

const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, string>>();

function code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected;
}

async function tokenAt(path: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readText(path, 4096));
    return record(value) && typeof value.token === "string" ? value.token : undefined;
  } catch {
    return undefined;
  }
}

async function stale(path: string): Promise<boolean> {
  try {
    const text = await readText(path, 4096);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (record(value) && Number.isInteger(value.pid) && Number(value.pid) > 0) {
      try {
        process.kill(Number(value.pid), 0);
        return false;
      } catch (error) {
        return code(error, "ESRCH");
      }
    }
    return Date.now() - (await stat(path)).mtimeMs > 30_000;
  } catch (error) {
    return isMissing(error);
  }
}

async function recover(lock: string): Promise<void> {
  // Serialize competing recoverers. Normal writers cannot acquire the occupied lock.
  const reap = `${lock}.reap`;
  let handle;
  try {
    handle = await open(reap, "wx", 0o600);
  } catch (error) {
    if (!code(error, "EEXIST")) throw error;
    if (await stale(reap))
      await rename(reap, `${reap}.stale.${randomUUID()}`).catch((failure: unknown) => {
        if (!isMissing(failure)) throw failure;
      });
    return;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }),
    );
    if (await stale(lock)) {
      await rename(lock, `${lock}.stale.${randomUUID()}`).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  } finally {
    await handle.close();
    await unlink(reap).catch(() => {});
  }
}

/**
 * Publish a complete lock record atomically before granting access to state.
 * A crash cannot leave a newly created empty lock that looks ownerless.
 */
export async function withStateLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const token = randomUUID();
  const candidate = `${lock}.${token}.candidate`;
  const file = await open(candidate, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
    await file.sync();
  } finally {
    await file.close();
  }
  const deadline = Date.now() + 2500;
  let acquired = false;
  try {
    for (;;) {
      try {
        await link(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!code(error, "EEXIST")) throw error;
        if (await stale(lock)) await recover(lock);
        if (Date.now() >= deadline)
          throw new Error(
            `Timed out waiting for ${lock}. State was not overwritten. Check its owner before removing a lock manually.`,
            { cause: error },
          );
        await delay(40);
      }
    }
    const locks = new Map(heldLocks.getStore() ?? []);
    locks.set(resolve(path), token);
    return await heldLocks.run(locks, action);
  } finally {
    await unlink(candidate).catch(() => {});
    if (acquired && (await tokenAt(lock)) === token) await unlink(lock).catch(() => {});
  }
}

/**
 * Replace validated state atomically and preserve the old file on failure.
 * The caller must validate existing state before requesting a replacement.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const token = heldLocks.getStore()?.get(resolve(path));
    if (token && (await tokenAt(`${path}.lock`)) !== token)
      throw new Error("State lock ownership changed; refusing to replace state.");
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
  if (!info.isFile() || info.size > 1024 * 1024)
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
