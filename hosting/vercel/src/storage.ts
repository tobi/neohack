import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  get,
  put,
  list,
  BlobNotFoundError,
  BlobPreconditionFailedError,
} from "@vercel/blob";

export type Document = { value: any; etag: string };
export interface Storage {
  read(path: string): Promise<Document | null>;
  head?(path: string): Promise<{ etag: string } | null>;
  write(path: string, value: unknown, etag?: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export class Conflict extends Error {}
// Dependency injection is request-scoped: tests exercise the real handlers without
// a production credential, and separate instances share the same CAS backend.
export const storageContext = new AsyncLocalStorage<Storage>();
const blob: Storage = {
  async read(path) {
    try {
      const result = await get(path, { access: "private", useCache: false });
      if (!result) return null;
      if (result.statusCode !== 200 || !result.stream)
        throw Error("Cannot read stored document");
      if (!result.blob.etag)
        throw Error("Stored document has no revision token");
      const bytes = Buffer.from(
        await new Response(result.stream).arrayBuffer(),
      );
      return {
        value: JSON.parse(gunzipSync(bytes).toString("utf8")),
        etag: result.blob.etag,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  },
  async write(path, value, etag) {
    try {
      await put(path, gzipSync(Buffer.from(JSON.stringify(value))), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: !!etag,
        contentType: "application/gzip",
        cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : {}),
      });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new Conflict();
      // A create-only writer may lose to another initial writer. Re-read before
      // classifying this as contention; authentication/network errors still fail.
      if (!etag && (await blob.read(path))) throw new Conflict();
      throw error;
    }
  },
  async list(prefix) {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      paths.push(...page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return paths;
  },
};
export const storage = () => storageContext.getStore() ?? blob;
export const configured = () =>
  !!storageContext.getStore() || !!process.env.BLOB_READ_WRITE_TOKEN;
export async function read<T = any>(path: string): Promise<T | null> {
  const value = (await storage().read(path))?.value ?? null;
  const expected = path.match(/^objects\/([a-f0-9]{64})\.json$/)?.[1];
  if (
    value !== null &&
    expected &&
    createHash("sha256").update(JSON.stringify(value)).digest("hex") !==
      expected
  )
    throw Error("Stored object hash differs");
  return value;
}
export async function update<T, R>(
  path: string,
  initial: () => T,
  change: (value: T) => R | Promise<R>,
): Promise<R> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const stored = await storage().read(path),
      value = stored?.value ?? initial();
    const before = JSON.stringify(value),
      result = await change(value);
    if (JSON.stringify(value) === before) return result;
    try {
      await storage().write(path, value, stored?.etag);
      return result;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  throw new Conflict("Concurrent storage update; retry the request");
}
export async function immutable(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const path = `objects/${hash}.json`;
  if (!(await read(path))) {
    try {
      await storage().write(path, value);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  return path;
}

// Auth uniqueness and passkey counters share one atomic document. Replay bodies
// and private projects are separate documents, never replicated through this one.
export class AuthStore {
  path = "accounts/auth.json";
  async get<T = any>(key: string): Promise<T | undefined> {
    return (await read(this.path))?.[key];
  }
  async put(key: string, value: any) {
    return this.transaction((txn) => txn.put(key, value));
  }
  async delete(key: string) {
    return this.transaction((txn) => txn.delete(key));
  }
  async transaction<R>(
    fn: (txn: {
      get<T = any>(key: string): Promise<T | undefined>;
      put(key: string, value: any): Promise<void>;
      delete(key: string): Promise<void>;
    }) => Promise<R>,
  ) {
    return update<Record<string, any>, R>(
      this.path,
      () => ({}),
      async (values) => {
        for (const [key, value] of Object.entries(values))
          if (
            (key.startsWith("session:") ||
              key.startsWith("challenge:") ||
              key.startsWith("rate:")) &&
            value.expires < Date.now()
          )
            delete values[key];
        return fn({
          get: async (key) => values[key],
          put: async (key, value) => {
            values[key] = value;
          },
          delete: async (key) => {
            delete values[key];
          },
        });
      },
    );
  }
}
