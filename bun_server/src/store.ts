// Disk-backed per-session store: input log + blobs.
// Layout: <dataDir>/<sessionId>/input.log.jsonl, blobs/<key>
import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";

export const DATA_DIR = process.env.SESSIONS_DIR ?? "../sessions";

export function sessionDir(id: string) {
  return join(DATA_DIR, sanitize(id));
}

export function blobsDir(id: string) {
  return join(sessionDir(id), "blobs");
}

export function inputLogPath(id: string) {
  return join(sessionDir(id), "input.log.jsonl");
}

function sanitize(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`bad session id: ${id}`);
  return basename(id);
}

export async function ensureSession(id: string): Promise<void> {
  await mkdir(blobsDir(id), { recursive: true });
  // Touch the input log so resume of an empty session is a no-op.
  const log = Bun.file(inputLogPath(id));
  if (!(await log.exists())) await writeFile(inputLogPath(id), "");
}

export async function appendInput(id: string, line: string): Promise<void> {
  await ensureSession(id);
  await appendFile(inputLogPath(id), line + "\n", "utf8");
}

export async function readInputLog(id: string): Promise<string[]> {
  try {
    const text = await readFile(inputLogPath(id), "utf8");
    return text.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export async function persistPut(id: string, key: string, dataB64: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new Error(`bad blob key: ${key}`);
  await ensureSession(id);
  await writeFile(join(blobsDir(id), key), Buffer.from(dataB64, "base64"));
}

export async function persistGet(id: string, key: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new Error(`bad blob key: ${key}`);
  try {
    const buf = await readFile(join(blobsDir(id), key));
    return buf.toString("base64");
  } catch {
    return null;
  }
}

export async function persistList(id: string): Promise<string[]> {
  try {
    return await readdir(blobsDir(id));
  } catch {
    return [];
  }
}
