// Explicit management operation, separate from the read-only archive store
// and from the live bridge queue. A worker sees one read-only source and one
// private writable workspace. Never fall back to unsandboxed web execution.
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { constants, createReadStream } from "node:fs";
import { validateFrame } from "../../client/recording.js";
import { createRunStore } from "./runs";
import { originAllowed, hostAllowed } from "./origin";
import { parseWireJson } from "./wire-json";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export interface ReconstructionJob {
  id: string;
  sourceSessionId: string;
  archiveId: string;
  state: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
  frames?: number;
  turn?: number;
  provenance?: unknown;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export function createReconstructor(
  root: string,
  options: { bridge?: string; bwrap?: string; timeoutMs?: number } = {},
) {
  root = resolve(root);
  const bridge = resolve(
    options.bridge ??
      process.env.NHXCLI ??
      resolve(import.meta.dir, "../bin/nhxcli"),
  );
  const bwrap = options.bwrap ?? process.env.BWRAP ?? "bwrap";
  const jobs = new Map<string, ReconstructionJob>();
  const completions = new Map<string, Promise<void>>();
  let active: string | null = null;
  const home = join(root, ".reconstruction-jobs");
  async function save(job: ReconstructionJob) {
    const folder = join(home, job.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(
      join(folder, "status.tmp"),
      JSON.stringify({ ...job, ownerPid: process.pid }, null, 2),
      { mode: 0o600 },
    );
    await rename(join(folder, "status.tmp"), join(folder, "status.json"));
  }
  async function source(id: string) {
    if (!ID.test(id)) throw Error("Invalid run id");
    const base = await realpath(root),
      dir = await realpath(join(base, id));
    if (dir !== join(base, id))
      throw Error("Source must be a direct run directory");
    if ((await realpath(join(dir, "playground"))) !== join(dir, "playground"))
      throw Error("Source playground cannot be a symlink");
    for (const name of [
      "input.log.jsonl",
      "playground/nhdat",
      "playground/sysconf",
      "playground/symbols",
      "playground/license",
    ]) {
      const path = join(dir, name),
        info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw Error(`Source ${name} must be a regular file`);
      const limit =
        name === "input.log.jsonl"
          ? 32 * 1024 * 1024
          : name === "playground/nhdat"
            ? 128 * 1024 * 1024
            : 1024 * 1024;
      if (info.size > limit)
        throw Error(`Source ${name} exceeds its size limit`);
    }
    let engine = "engine";
    try {
      await lstat(join(dir, engine));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      engine = "playground/nethack";
    }
    const file = join(dir, engine),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 * 1024 * 1024
    )
      throw Error(
        "Source engine must be a regular pinned executable under 128 MB",
      );
    await access(file, constants.X_OK);
    const lease = join(dir, ".lease");
    const guard = await open(
      lease,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await guard.stat()).isFile()) throw Error("Invalid source lease");
    } finally {
      await guard.close();
    }
    return { id, dir, engine, lease };
  }
  async function sandboxCommand(
    src: { id: string; dir: string; engine: string; lease: string },
    workspace: string,
    runtime: string,
  ) {
    if (!Bun.which(bwrap) || !Bun.which("prlimit"))
      throw Object.assign(
        Error(
          "Sandbox tools are unavailable; no unsandboxed conversion was attempted",
        ),
        { code: "sandboxUnavailable" },
      );
    const command = [
      "prlimit",
      "--as=805306368",
      "--cpu=120",
      "--",
      bwrap,
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
    ];
    for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
      try {
        await access(path);
        command.push("--ro-bind", path, path);
      } catch {}
    }
    command.push("--proc", "/proc", "--dev", "/dev", "--dir", "/etc");
    for (const name of ["passwd", "group", "nsswitch.conf"])
      command.push("--ro-bind", join(runtime, name), `/etc/${name}`);
    for (const name of ["ld.so.cache", "localtime"]) {
      try {
        await access(`/etc/${name}`);
        command.push("--ro-bind", `/etc/${name}`, `/etc/${name}`);
      } catch {}
    }
    command.push(
      "--dir",
      "/sources",
      "--dir",
      `/sources/${src.id}`,
      "--dir",
      `/sources/${src.id}/playground`,
    );
    // Only the input stream, pinned executable and static data enter the
    // sandbox. Future saves/bones/blobs and other run metadata are not visible.
    for (const name of [
      "input.log.jsonl",
      src.engine,
      "playground/nhdat",
      "playground/sysconf",
      "playground/symbols",
      "playground/license",
    ])
      command.push(
        "--ro-bind",
        join(src.dir, name),
        `/sources/${src.id}/${name}`,
      );
    // Mount the existing lease inode writable, not the source directory.
    command.push("--bind", src.lease, `/sources/${src.id}/.lease`);
    // Legacy binaries embed SYSCF_FILE as an absolute path and ignore HACKDIR
    // for this one file. Bind only the captured sysconf at those literal aliases;
    // never expose the surrounding home or original playground directory.
    const binary = await readFile(join(src.dir, src.engine));
    const aliases: string[] = [];
    for (
      let start = binary.indexOf(47);
      start >= 0;
      start = binary.indexOf(47, start + 1)
    ) {
      if (start && binary[start - 1] !== 0) continue;
      const end = binary.indexOf(0, start);
      if (end < 0) break;
      if (end - start > 4096 || end - start < 8) continue;
      if (binary.toString("utf8", end - 8, end) !== "/sysconf") continue;
      const path = binary.toString("utf8", start, end);
      if (/[\x00-\x1f]/.test(path))
        throw Error("Invalid compiled sysconf alias");
      aliases.push(path);
    }
    if (new Set(aliases).size > 8)
      throw Error("Too many compiled sysconf aliases");
    for (const path of new Set(aliases)) {
      if (
        path.split("/").includes("..") ||
        /^\/(proc|dev|sys|work|sources)(\/|$)/.test(path)
      )
        throw Error("Unsupported compiled sysconf location");
      command.push("--ro-bind", join(src.dir, "playground/sysconf"), path);
    }
    command.push(
      "--ro-bind",
      bridge,
      "/bridge",
      "--bind",
      workspace,
      "/work",
      "--chdir",
      "/work",
    );
    command.push(
      "--setenv",
      "HOME",
      "/work/home",
      "--setenv",
      "TMPDIR",
      "/work/tmp",
      "--setenv",
      "USER",
      "explorer",
      "--setenv",
      "LOGNAME",
      "explorer",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "NETHACKOPTIONS",
      "!tutorial,time",
      "--setenv",
      "LC_ALL",
      "C.UTF-8",
    );
    command.push(
      "/bridge",
      `/sources/${src.id}/${src.engine}`,
      `/sources/${src.id}/playground`,
      "/sources",
    );
    return command;
  }
  async function execute(job: ReconstructionJob) {
    const folder = join(home, job.id),
      workspace = join(folder, "work"),
      runtime = join(folder, "runtime");
    try {
      const src = await source(job.sourceSessionId);
      await mkdir(join(workspace, "output"), { recursive: true, mode: 0o700 });
      await mkdir(join(workspace, "home"), { recursive: true, mode: 0o700 });
      await mkdir(join(workspace, "tmp"), { recursive: true, mode: 0o700 });
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const uid = process.getuid?.() ?? 1000,
        gid = process.getgid?.() ?? 1000;
      await writeFile(
        join(runtime, "passwd"),
        `explorer:x:${uid}:${gid}:Explorer:/work/home:/bin/false\n`,
      );
      await writeFile(join(runtime, "group"), `explorer:x:${gid}:\n`);
      await writeFile(
        join(runtime, "nsswitch.conf"),
        "passwd: files\ngroup: files\nhosts: files\n",
      );
      const command = await sandboxCommand(src, workspace, runtime);
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(command, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch {
        throw Object.assign(
          Error(
            "Bubblewrap is unavailable; no unsandboxed conversion was attempted",
          ),
          { code: "sandboxUnavailable" },
        );
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, options.timeoutMs ?? 190000);
      const collect = async (
        stream: ReadableStream<Uint8Array>,
        limit: number,
        tail = false,
      ) => {
        const reader = stream.getReader(),
          decoder = new TextDecoder();
        let bytes = 0,
          text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > limit) {
            proc.kill("SIGKILL");
            throw Error("Reconstruction worker output exceeded its budget");
          }
          text += decoder.decode(value, { stream: true });
          if (tail) text = text.slice(-32768);
        }
        return text + decoder.decode();
      };
      const outPromise = collect(
          proc.stdout as ReadableStream<Uint8Array>,
          2 * 1024 * 1024,
        ),
        errPromise = collect(
          proc.stderr as ReadableStream<Uint8Array>,
          4 * 1024 * 1024,
          true,
        );
      proc.stdin.write(
        JSON.stringify({
          tool: "reconstruct_run",
          sessionId: job.sourceSessionId,
          archiveId: job.archiveId,
          outputRoot: "/work/output",
        }) + "\n",
      );
      proc.stdin.end();
      let exit: number, stdout: string, stderr: string;
      try {
        [exit, stdout, stderr] = await Promise.all([
          proc.exited,
          outPromise,
          errPromise,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (stderr)
        await writeFile(join(folder, "diagnostic.log"), stderr.slice(-32768), {
          mode: 0o600,
        });
      if (timedOut)
        throw Object.assign(
          Error("Reconstruction exceeded its deadline; source was not changed"),
          { code: "reconstructionTimeout" },
        );
      if (
        exit !== 0 &&
        stderr.includes("bwrap:") &&
        /Operation not permitted|Permission denied|No permissions/.test(stderr)
      )
        throw Object.assign(
          Error(
            "Host policy prevents sandbox setup. See docs/RECONSTRUCTION.md; no unsandboxed fallback was attempted.",
          ),
          { code: "sandboxUnavailable" },
        );
      if (exit !== 0)
        throw Object.assign(
          Error(
            "Sandboxed worker could not complete; no unsandboxed fallback was attempted",
          ),
          { code: "sandboxFailed" },
        );
      let result: any;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        throw Error("Worker returned an invalid reconstruction response");
      }
      if (result.error)
        throw Object.assign(Error(result.error.message), {
          code: result.error.code,
        });
      if (
        result.archiveId !== job.archiveId ||
        result.provenance?.verification !== "unverified" ||
        !result.provenance?.complete ||
        !(result.frames > 0)
      )
        throw Error("Worker did not produce a complete derived recording");
      const archive = join(workspace, "output", job.archiveId),
        target = join(root, job.archiveId);
      const allowed = new Set([
        "perceptions.jsonl",
        "perceptions.index.jsonl",
        "run.json",
        "meta.json",
        ".lease",
      ]);
      for (const name of allowed) {
        const info = await lstat(join(archive, name));
        if (!info.isFile() || info.isSymbolicLink())
          throw Error("Archive contains an unsafe non-regular file");
      }
      const meta = JSON.parse(
        await readFile(join(archive, "run.json"), "utf8"),
      );
      const marker = JSON.parse(
        await readFile(join(archive, "meta.json"), "utf8"),
      );
      if (
        meta.sessionId !== job.archiveId ||
        meta.provenance?.sourceSessionId !== job.sourceSessionId ||
        meta.frames !== result.frames ||
        marker.recordingOnly !== true ||
        marker.frameCount !== result.frames
      )
        throw Error("Archive metadata does not match the conversion");
      try {
        await lstat(target);
        throw Error("Archive destination already exists");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      // Validate the final bytes after the sandbox has exited. A historical
      // executable cannot make the publisher trust a corrupt index or replace
      // an archive file with a host-resolved symlink during its shutdown.
      const index = await createRunStore(join(workspace, "output")).index(
        job.archiveId,
        { strict: true },
      );
      if (index.length !== result.frames)
        throw Error("Archive frame count mismatch");
      const dataPath = join(archive, "perceptions.jsonl"),
        info = await lstat(dataPath);
      if (
        info.size > 288 * 1024 * 1024 ||
        index.at(-1)?.offset + index.at(-1)?.length !== info.size
      )
        throw Error("Archive byte bounds mismatch");
      let buffer = "",
        sequence = 0,
        offset = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const stream = createReadStream(dataPath, { highWaterMark: 65536 });
      try {
        for await (const chunk of stream) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.length > 8 * 1024 * 1024)
              throw Error("Archive frame exceeds supported size");
            const frame = validateFrame(JSON.parse(line)),
              row = index[sequence],
              length = Buffer.byteLength(line) + 1;
            if (
              !row ||
              frame.sequence !== sequence ||
              row.offset !== offset ||
              row.length !== length ||
              row.turn !== frame.response.observation.turn ||
              frame.response.sessionId !== job.archiveId ||
              frame.response.provenance?.readOnly !== true ||
              frame.response.provenance.sourceSessionId !== job.sourceSessionId
            )
              throw Error("Archive frame/index mismatch");
            sequence++;
            offset += length;
          }
          if (buffer.length > 8 * 1024 * 1024)
            throw Error("Archive contains an oversized or unterminated frame");
        }
        buffer += decoder.decode();
        if (buffer.length || sequence !== result.frames)
          throw Error("Archive is incomplete");
      } finally {
        stream.destroy();
      }
      // Retain only public archive data and its read-only semantic marker. Raw
      // inputs/binaries/scratch saves are not needed by the viewer or export.
      for (const file of await readdir(archive))
        if (!allowed.has(file))
          await rm(join(archive, file), { recursive: true, force: true });
      await rename(archive, target);
      Object.assign(job, {
        state: "completed",
        frames: result.frames,
        turn: result.turn,
        provenance: result.provenance,
      });
    } catch (e: any) {
      job.state = "failed";
      job.error = {
        code: e.code ?? "reconstructionFailed",
        message: e.message ?? "Reconstruction failed",
      };
    } finally {
      job.finishedAt = Date.now();
      try {
        await save(job);
      } catch (e) {
        console.error("Could not persist reconstruction job status", e);
      }
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (e) {
        console.error("Could not remove reconstruction workspace", e);
      }
      active = null;
    }
  }
  async function start(id: string) {
    if (!ID.test(id)) return { status: 400, body: { error: "Invalid run id" } };
    if (active) {
      const job = jobs.get(active)!;
      return job.sourceSessionId === id
        ? { status: 202, body: { job } }
        : { status: 429, body: { error: "Another reconstruction is running" } };
    }
    // Validate paths before allocating a job; this does not start an engine.
    try {
      await source(id);
    } catch (e: any) {
      return { status: 400, body: { error: e.message } };
    }
    if (active) {
      const job = jobs.get(active)!;
      return job.sourceSessionId === id
        ? { status: 202, body: { job } }
        : { status: 429, body: { error: "Another reconstruction is running" } };
    }
    const job: ReconstructionJob = {
      id: crypto.randomUUID(),
      sourceSessionId: id,
      archiveId: `r-${crypto.randomUUID().replaceAll("-", "")}`,
      state: "running",
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    active = job.id;
    while (jobs.size > 50) jobs.delete(jobs.keys().next().value!);
    try {
      await save(job);
    } catch {
      jobs.delete(job.id);
      active = null;
      return {
        status: 500,
        body: { error: "Cannot persist reconstruction job" },
      };
    }
    const task = execute(job).catch(() => {
      job.state = "failed";
      job.error = {
        code: "workerFailure",
        message: "Reconstruction worker failed",
      };
      active = null;
    });
    completions.set(job.id, task);
    task.finally(() => completions.delete(job.id));
    return { status: 202, body: { job } };
  }
  async function get(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    if (jobs.has(id)) return jobs.get(id);
    try {
      const { ownerPid, ...job } = JSON.parse(
        await readFile(join(home, id, "status.json"), "utf8"),
      );
      if (job.state !== "running") return job;
      try {
        const meta = JSON.parse(
          await readFile(join(root, job.archiveId, "run.json"), "utf8"),
        );
        if (
          meta.provenance?.complete &&
          meta.provenance.sourceSessionId === job.sourceSessionId
        )
          return {
            ...job,
            state: "completed",
            frames: meta.frames,
            turn: meta.turn,
            provenance: meta.provenance,
          };
      } catch {}
      try {
        if (Number.isInteger(ownerPid)) {
          process.kill(ownerPid, 0);
          return job;
        }
      } catch {}
      return {
        ...job,
        state: "failed",
        error: {
          code: "workerInterrupted",
          message:
            "Worker status was lost during a server restart; no partial output was published",
        },
      };
    } catch {
      return null;
    }
  }
  async function handle(req: Request) {
    if (!hostAllowed(req)) return json({ error: "Host is not permitted" }, 403);
    const url = new URL(req.url),
      create = /^\/runs\/([A-Za-z0-9_-]{1,64})\/reconstruct$/.exec(
        url.pathname,
      ),
      status = /^\/reconstructions\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (create) {
      if (req.method !== "POST")
        return json(
          { error: "Reconstruction requires an explicit POST confirmation" },
          405,
        );
      if (!originAllowed(req))
        return json({ error: "Origin is not permitted" }, 403);
      let body: any;
      try {
        body = parseWireJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await req.arrayBuffer(),
          ),
        );
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (
        body?.confirm !== true ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, "confirm")
      )
        return json(
          { error: "Confirm unverified reconstruction explicitly" },
          400,
        );
      const r = await start(create[1]);
      return json(r.body, r.status);
    }
    if (status && req.method === "GET") {
      const job = await get(status[1]);
      return job
        ? json({ job })
        : json({ error: "Unknown reconstruction" }, 404);
    }
    return json({ error: "Unknown reconstruction route" }, 404);
  }
  return {
    start,
    get,
    handle,
    async wait(id: string) {
      await completions.get(id);
      return get(id);
    },
  };
}
export const reconstructor = createReconstructor(
  process.env.SESSIONS_DIR ?? resolve(import.meta.dir, "../../sessions"),
);
