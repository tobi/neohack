// Engine-free, bounded validation of the authoritative checkpoint stream.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { validateFrame } from "../../client/recording.js";
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_FRAMES = 100000;
export const signature = (s: any) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
export async function openArchive(path: string) {
  const f = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1)
      throw Error("Archive must be a regular single-link file");
    if (s.size > MAX_ARCHIVE_BYTES)
      throw Error("Archive exceeds the 8 GiB review limit");
    return { f, s };
  } catch (error) {
    await f.close();
    throw error;
  }
}
export function checkedFrame(text: string, id: string, sequence: number) {
  const frame = validateFrame(JSON.parse(text)),
    r = frame.response;
  if (
    frame.sequence !== sequence ||
    r.sessionId !== id ||
    !Number.isSafeInteger(frame.recordedAt) ||
    frame.recordedAt < 0 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    !Number.isSafeInteger(r.observation.turn) ||
    r.observation.turn < 0 ||
    (frame.gapBefore !== undefined && typeof frame.gapBefore !== "boolean") ||
    (frame.requestsThrough !== undefined &&
      (!Number.isSafeInteger(frame.requestsThrough) ||
        frame.requestsThrough < 0))
  )
    throw Error("Invalid checkpoint identity, sequence or boundary");
  return frame;
}
export async function scanArchive(path: string, id: string) {
  const { f, s } = await openArchive(path);
  const rows: any[] = [],
    gaps: number[] = [];
  let position = 0,
    validBytes = 0,
    parts: Buffer[] = [],
    pending = 0,
    last: any = null,
    issue: string | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (position < s.size && !issue) {
      const block = Buffer.allocUnsafe(Math.min(65536, s.size - position));
      const { bytesRead } = await f.read(block, 0, block.length, position);
      if (!bytesRead)
        throw Error("Archive changed while being read; reopen it");
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = block.indexOf(10, start),
          end = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
        const part = block.subarray(start, end);
        parts.push(part);
        pending += part.length;
        if (pending > MAX_FRAME_BYTES) {
          issue = "oversized checkpoint";
          break;
        }
        if (newline < 0 || newline >= bytesRead) break;
        if (rows.length >= MAX_FRAMES) {
          issue = "checkpoint count limit";
          break;
        }
        try {
          last = checkedFrame(
            decoder.decode(Buffer.concat(parts, pending)),
            id,
            rows.length,
          );
          rows.push({
            sequence: last.sequence,
            offset: validBytes,
            length: pending,
            turn: last.response.observation.turn,
            revision: last.response.revision,
            gapBefore: !!last.gapBefore,
          });
          if (last.gapBefore) gaps.push(last.sequence);
          validBytes += pending;
        } catch {
          issue = "invalid checkpoint or sequence";
          break;
        }
        parts = [];
        pending = 0;
        start = end;
      }
    }
    if (!issue && pending)
      issue = "incomplete trailing checkpoint (possibly an active write)";
    const after = await f.stat();
    if (after.ino !== s.ino || after.size < s.size)
      throw Error("Archive changed while being read; reopen it");
  } finally {
    await f.close();
  }
  const state = issue
    ? issue.startsWith("incomplete")
      ? "partial"
      : issue.includes("limit") || issue.includes("oversized")
        ? "limited"
        : "corrupt"
    : "complete";
  return {
    rows,
    last,
    stat: s,
    signature: signature(s),
    integrity: {
      state,
      issue,
      validBytes,
      totalBytes: s.size,
      completeFrames: rows.length,
      gaps,
      notice: issue
        ? "Only the validated prefix is available for playback/export. Original bytes were not changed."
        : gaps.length
          ? "Unrecorded request boundaries exist before marked checkpoints; no missing observations were invented."
          : null,
    },
  };
}
export type ArchiveSnapshot = Awaited<ReturnType<typeof scanArchive>>;
export function archiveSummary(snapshot: ArchiveSnapshot, id: string) {
  const r = snapshot.last?.response,
    o = r?.observation;
  return {
    format: "neonethack.perception",
    version: 1,
    sessionId: id,
    title: o?.vitals?.title ?? "Explorer",
    turn: o?.turn ?? 0,
    revision: r?.revision ?? 0,
    depth: o?.vitals?.depth ?? o?.location?.depthLabel ?? "unknown",
    frames: snapshot.rows.length,
    bytes: snapshot.integrity.validBytes,
    updatedAt: snapshot.last?.recordedAt ?? snapshot.stat.mtimeMs,
    ended: !!r?.ended,
    ...(r?.end ? { end: r.end } : {}),
    ...(r?.provenance ? { provenance: r.provenance } : {}),
    replayReady: snapshot.rows.length > 0,
    integrity: snapshot.integrity,
    ...(!snapshot.rows.length
      ? { reason: "No complete public checkpoints are available." }
      : {}),
  };
}
