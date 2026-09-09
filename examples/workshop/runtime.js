import { fork } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  access,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NativeTransport } from "../../lib/neonethack/dist/typescript/native.js";
import {
  Neonethack,
  isSnapshot,
} from "../../lib/neonethack/dist/typescript/client.js";
import { toolMethods } from "../../lib/neonethack/dist/mcp/tools.js";
import { repository, loadProject, validateProject } from "./projects.js";

// Each invocation owns a fresh engine session and a killable script process.
// This is a host for trusted local JavaScript, not a security sandbox.
export async function runProject(input, options = {}) {
  const project =
    typeof input === "string"
      ? await loadProject(input)
      : { ...input, files: validateProject(input.files) };
  const callsLimit = options.calls ?? 1000;
  const timeout = options.timeout ?? 30000;
  const seed = options.seed ?? 42;
  if (
    !Number.isSafeInteger(callsLimit) ||
    callsLimit < 1 ||
    callsLimit > 100000
  )
    throw Error("calls must be 1–100000");
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3600000)
    throw Error("timeout must be 100–3600000 milliseconds");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295)
    throw Error("seed must be a uint32");
  const library = resolve(repository, "lib/neonethack");
  const executable =
    options.executable ??
    process.env.NEONETHACK_EXECUTABLE ??
    resolve(library, "build/native/neonethack");
  await access(executable).catch(() => {
    throw Error("Build the native engine first: make -C lib/neonethack test");
  });
  const temporary = await mkdtemp(resolve(tmpdir(), "neohack-workshop-"));
  let transport, child, timer, trace;
  let inflight = Promise.resolve();
  let childClosed = Promise.resolve();
  const started = Date.now();
  const squares = new Set();
  const known = new Set();
  const levels = new Set();
  const summary = {
    name: project.name,
    seed,
    role: options.identity?.role ?? options.role ?? "valkyrie",
    reason: "error",
    calls: 0,
    moves: 0,
    noMovement: 0,
    blocked: 0,
    turn: 0,
    maxDepth: 0,
    uniqueSquares: 0,
    knownSquares: 0,
    levels: [],
    logs: [],
  };
  let finish;
  let stopping = false;
  let busy = false;
  let last;
  const counted = new Set();
  const stop = (reason, error) => {
    if (stopping) return;
    stopping = true;
    summary.reason = reason;
    if (error) summary.error = error;
    child?.kill("SIGKILL");
    finish?.();
  };
  const abort = () => stop("interrupted");
  function observe(snapshot) {
    last = snapshot;
    const observation = snapshot.observation;
    const level = observation.location.id;
    levels.add(observation.location.depthLabel.trim());
    summary.sessionId = snapshot.sessionId;
    summary.turn = observation.turn;
    summary.maxDepth = Math.max(
      summary.maxDepth,
      observation.knowledge?.levels?.find((entry) => entry.id === level)
        ?.depth ?? 0,
    );
    summary.lastOutcome = snapshot.outcome;
    summary.lastMessages = observation.heard;
    summary.decision = snapshot.decision ?? null;
    summary.end = snapshot.end ?? null;
    if (observation.you)
      squares.add(`${level}:${observation.you.x},${observation.you.y}`);
    for (const cell of observation.world) {
      if (!["unknown", "dark"].includes(cell.terrain.type))
        known.add(`${level}:${cell.x},${cell.y}`);
    }
    summary.uniqueSquares = squares.size;
    summary.knownSquares = known.size;
    summary.levels = [...levels];
  }
  try {
    const staging = resolve(temporary, "project");
    await mkdir(resolve(staging, "node_modules"), { recursive: true });
    await symlink(library, resolve(staging, "node_modules/neonethack"), "dir");
    await writeFile(
      resolve(staging, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    for (const [name, source] of Object.entries(project.files))
      await writeFile(resolve(staging, name), source);
    if (options.trace) trace = await open(resolve(options.trace), "wx");
    transport = new NativeTransport({
      executable,
      enginePath:
        options.enginePath ?? resolve(library, "engine/playground/nethack"),
      dataPath: options.dataPath ?? resolve(library, "engine/playground"),
      sessionsPath: resolve(temporary, "sessions"),
      // Script execution has its own timer below. Engine startup and an already
      // accepted operation keep the transport's normal bounded response time.
    });
    const api = new Neonethack(transport);
    const game = await api.create({
      role: summary.role,
      race: "human",
      gender: "female",
      align: "lawful",
      ...options.identity,
      seed,
      name: "Workshop test",
    });
    observe(game.state);
    if (trace)
      await trace.write(JSON.stringify({ initial: game.state }) + "\n");
    const completion = new Promise((resolve) => {
      finish = resolve;
    });
    const allowed = new Set(toolMethods.values());
    child = fork(new URL("./worker.js", import.meta.url), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
    });
    childClosed = new Promise((resolve) => child.once("close", resolve));
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-4000);
    });
    child.on("error", (error) => stop("error", String(error)));
    child.on("exit", (code, signal) => {
      if (!stopping)
        stop("error", `Script exited (${code ?? signal}). ${stderr}`);
    });
    child.on("message", (message) => {
      if (stopping) return;
      if (message.type === "ready") {
        summary.name = message.name;
        return;
      }
      if (message.type === "log") {
        const text = String(message.text).slice(0, 2000);
        summary.logs.push(text);
        if (summary.logs.length > 100) summary.logs.shift();
        options.log?.(text);
        return;
      }
      if (message.type === "controls") {
        summary.controls = message.controls;
        return;
      }
      if (message.type === "done") {
        stop(message.reason, message.error);
        return;
      }
      if (message.type !== "request") return;
      const { id, request } = message;
      const reply = (value) => {
        if (!stopping && child.connected)
          child.send({ type: "response", id, ...value });
      };
      if (
        !Number.isSafeInteger(id) ||
        request?.version !== 1 ||
        !allowed.has(request.method)
      ) {
        stop("error", "Invalid tool request");
        return;
      }
      if (request.method === "session.create") {
        reply({
          error: "The workshop owns session creation. Use the supplied game.",
        });
        return;
      }
      if (
        request.method !== "protocol.describe" &&
        request.params?.sessionId !== game.id
      ) {
        stop("error", "Request outside this test session");
        return;
      }
      if (busy) {
        stop("error", "Concurrent requests: await each game operation.");
        return;
      }
      if (summary.calls >= callsLimit) {
        stop("budget");
        return;
      }
      summary.calls++;
      busy = true;
      inflight = (async () => {
        try {
          const result = await transport.send(request);
          if (trace)
            await trace.write(
              JSON.stringify({ request, response: result }) + "\n",
            );
          if (isSnapshot(result)) {
            observe(result);
            const receipt = `${result.sessionId}:${result.revision}`;
            if (result.outcome.positionChanged && !counted.has(receipt))
              summary.moves++;
            counted.add(receipt);
            if (
              request.method === "game.move" &&
              !result.outcome.positionChanged
            )
              summary.noMovement++;
            if (result.outcome.status === "blocked") summary.blocked++;
            if (
              result.outcome.status === "unknown" ||
              [result.storage, result.recording].some(
                (value) => value && value.status !== "ok",
              )
            ) {
              stop("uncertain");
              return;
            }
          } else if (result.error?.code === "incompleteRequest") {
            stop("uncertain");
            return;
          }
          reply({ result });
        } catch (error) {
          stop("uncertain", String(error));
        } finally {
          busy = false;
        }
      })();
    });
    timer = setTimeout(() => stop("timeout"), timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) stop("interrupted");
    else
      child.send({
        type: "start",
        initial: game.state,
        entrypoint: resolve(staging, "main.js"),
      });
    await completion;
  } catch (error) {
    summary.error = String(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    child?.kill("SIGKILL");
    await childClosed;
    await inflight;
    await transport?.close().catch((error) => {
      summary.error ??= String(error);
    });
    await trace?.close();
    await rm(temporary, { recursive: true, force: true });
  }
  summary.elapsedMs = Date.now() - started;
  if (last) summary.revision = last.revision;
  return summary;
}
