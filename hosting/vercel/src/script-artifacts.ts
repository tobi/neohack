import { read, update, immutable } from "./storage.ts";
import { createHash } from "node:crypto";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sourceRecord(source: any) {
  const files = (value: any) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 20 &&
    Object.hasOwn(value, "main.js") &&
    Object.entries(value).every(
      ([k, v]) => /^[\w-]+\.js$/.test(k) && typeof v === "string",
    );
  if (
    source?.version !== 1 ||
    source.entrypoint !== "main.js" ||
    !files(source.files) ||
    !files(source.compiledFiles) ||
    JSON.stringify(source).length > 500000 ||
    JSON.stringify(Object.keys(source.files).sort()) !==
      JSON.stringify(Object.keys(source.compiledFiles).sort()) ||
    source.compiler?.name !== "typescript" ||
    typeof source.compiler.version !== "string" ||
    source.compiler.version.length > 40
  )
    throw Error("Invalid script source");
  const artifact = JSON.stringify(source);
  return {
    artifact,
    sha256: createHash("sha256").update(artifact).digest("hex"),
  };
}
export async function scriptArtifacts(uid: string, id: string, body: any) {
  if (body.owner !== uid) return json({ error: "Script account differs" }, 403);
  if (
    !Number.isSafeInteger(body.from) ||
    body.from < 0 ||
    !Array.isArray(body.entries) ||
    body.entries.length > 32 ||
    body.from + body.entries.length > 10000 ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 60 ||
    // oxlint-disable-next-line no-control-regex -- Reject or strip control characters at this text boundary.
    /[\u0000-\u001f\u007f]/.test(body.name)
  )
    return json({ error: "Invalid script batch" }, 400);
  const archive = await read("input-runs/" + id + ".json");
  if (!archive || archive.accountId !== uid || archive.control !== "bot")
    return json({ error: "Run not found" }, 404);
  for (const entry of body.entries)
    if (
      entry?.source !== "script" ||
      entry.author !== body.name ||
      typeof entry.text !== "string" ||
      entry.text.length > 2000 ||
      !Number.isSafeInteger(entry.turn) ||
      entry.turn < 0 ||
      entry.turn > (archive.summary?.turn ?? 0) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      entry.revision > (archive.summary?.revision ?? 0)
    )
      return json({ error: "Script note has no recorded boundary" }, 409);
  let source: ReturnType<typeof sourceRecord> | undefined;
  if (body.source !== undefined) {
    try {
      source = sourceRecord(body.source);
    } catch {
      return json({ error: "Invalid script source" }, 400);
    }
  }
  return update<any, Response>(
    "accounts/" + uid + "/runs/" + id + ".json",
    () => ({}),
    async (doc) => {
      if (!doc.inputRun)
        return json({ error: "Input run is not associated" }, 409);
      const notes = [...(doc.notes ?? [])];
      if (doc.source) {
        if (doc.run.name !== body.name)
          return json({ error: "Script identity differs" }, 409);
        if (source && (await read(doc.source))?.sha256 !== source.sha256)
          return json({ error: "Script source differs" }, 409);
      } else {
        if (!source || body.from !== 0)
          return json({ error: "Initial script source required" }, 409);
      }
      if (body.from > notes.length)
        return json({ error: "Script journal gap" }, 409);
      for (let i = 0; i < body.entries.length; i++) {
        const entry = body.entries[i],
          at = body.from + i;
        if (at < notes.length) {
          if (JSON.stringify(await read(notes[at])) !== JSON.stringify(entry))
            return json({ error: "Script journal differs" }, 409);
        } else notes.push(await immutable(entry));
      }
      if (!doc.source) {
        doc.source = await immutable(source);
        doc.run.name = body.name;
      }
      doc.notes = notes;
      doc.run.automated = true;
      doc.run.sourceHash = source?.sha256 ?? doc.run.sourceHash;
      doc.run.noteCount = notes.length;
      return json({ through: body.from + body.entries.length });
    },
  );
}
