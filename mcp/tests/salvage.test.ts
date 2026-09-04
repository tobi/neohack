import { test, expect } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  symlinkSync,
  linkSync,
  watch,
  openSync,
  closeSync,
  ftruncateSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { salvageRun } from "../src/salvage";
import { parseRecording, LocalRecording } from "../../client/recording.js";
import { TestBridge, testDirectory, ROOT } from "./bridge-harness";
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
function tree(path: string): any {
  return Object.fromEntries(
    readdirSync(path)
      .sort()
      .map((n) => {
        const p = join(path, n),
          s = lstatSync(p);
        return [
          n,
          s.isDirectory()
            ? tree(p)
            : { bytes: s.size, sha256: hash(p), mode: s.mode },
        ];
      }),
  );
}
async function fixture() {
  const root = testDirectory("salvage-source"),
    b = new TestBridge(root);
  try {
    const g = await b.newGame();
    await b.call("act", {
      sessionId: g.sessionId,
      action: "wait",
      requestId: "preserve-reservation",
    });
    await b.close();
    const path = join(root, g.sessionId),
      prefix = readFileSync(join(path, "perceptions.jsonl"), "utf8");
    appendFileSync(join(path, "perceptions.jsonl"), '{"sequence":2');
    return {
      root,
      id: g.sessionId,
      path,
      prefix,
      dest: join(testDirectory("salvage-output"), "bundle"),
    };
  } finally {
    await b.close();
  }
}

test("salvage preserves every byte, pin and reservation; prefix imports read-only with its warning", async () => {
  const f = await fixture(),
    before = tree(f.path),
    b = new TestBridge(f.root);
  try {
    const result = await salvageRun(f.root, f.id, f.dest, { confirm: true });
    expect(tree(f.path)).toEqual(before);
    expect(result.integrity.state).toBe("partial");
    expect(result.readOnly).toBe(true);
    expect(result.engineExecuted).toBe(false);
    expect(result.liveRecovery).toBe(false);
    for (const entry of result.entries)
      if (entry.kind === "file") {
        const copy = join(f.dest, "evidence", entry.path);
        expect(hash(copy)).toBe(hash(join(f.path, entry.path)));
        expect(entry.sha256).toBe(hash(copy));
        expect(lstatSync(copy).mode & 0o777).toBe(0o400);
      }
    expect(result.entries.some((e) => e.path === "requests.seen.jsonl")).toBe(
      true,
    );
    expect(result.entries.some((e) => e.path === "engine")).toBe(true);
    const review = readFileSync(join(f.dest, result.review!.file), "utf8");
    expect(review.slice(review.indexOf("\n") + 1)).toBe(f.prefix);
    const recording = new LocalRecording(parseRecording(review));
    expect(recording.frames).toEqual(parseRecording(f.prefix));
    expect(recording.integrity.state).toBe("partial");
    expect(recording.integrity.notice).toContain("No engine ran");
    expect(result.review!.sha256).toBe(hash(join(f.dest, result.review!.file)));
    expect(
      JSON.parse(readFileSync(join(f.dest, "manifest.json"), "utf8")).state,
    ).toBe("complete");
    expect((await b.call("resume", { sessionId: f.id })).error.code).toBe(
      "recordingUnavailable",
    );
    expect(tree(f.path)).toEqual(before);
  } finally {
    await b.close();
  }
}, 20000);

test("source ownership excludes salvage before creating a destination", async () => {
  const root = testDirectory("salvage-busy"),
    b = new TestBridge(root),
    dest = join(testDirectory("salvage-output"), "bundle");
  try {
    const g = await b.newGame();
    await expect(
      salvageRun(root, g.sessionId, dest, { confirm: true }),
    ).rejects.toThrow("busy");
    expect(existsSync(dest)).toBe(false);
  } finally {
    await b.close();
  }
});

test("salvage keeps the source lease after the flock helper exits, through copying", async () => {
  const f = await fixture(),
    b = new TestBridge(f.root);
  let watcher: ReturnType<typeof watch>, timer: ReturnType<typeof setTimeout>;
  try {
    const rival = new Promise<any>((resolve, reject) => {
      let started = false;
      watcher = watch(join(f.dest, ".."), (_event, name) => {
        if (!started && String(name) === basename(f.dest)) {
          started = true;
          b.call("resume", { sessionId: f.id }).then(resolve, reject);
        }
      });
      timer = setTimeout(() => reject(Error("No bundle creation event")), 5000);
    });
    const result = await Promise.all([
      salvageRun(f.root, f.id, f.dest, { confirm: true }),
      rival,
    ]);
    expect(result[1].error.code).toBe("sessionBusy");
    // Positive control: lock was released, and only damaged recording blocks resume.
    expect((await b.call("resume", { sessionId: f.id })).error.code).toBe(
      "recordingUnavailable",
    );
  } finally {
    watcher!.close();
    clearTimeout(timer!);
    await b.close();
  }
}, 15000);

for (const kind of ["symlink", "hardlink", "oversized"])
  test(`unsafe ${kind} evidence fails closed with a retained, explicitly incomplete bundle`, async () => {
    const f = await fixture(),
      evil = join(f.path, "000-unsafe");
    if (kind === "symlink") symlinkSync("/etc/passwd", evil);
    if (kind === "hardlink") linkSync(join(f.path, "meta.json"), evil);
    if (kind === "oversized") {
      const fd = openSync(evil, "wx");
      ftruncateSync(fd, 8 * 1024 ** 3 + 1);
      closeSync(fd);
    }
    const input = hash(join(f.path, "input.log.jsonl")),
      data = hash(join(f.path, "perceptions.jsonl"));
    await expect(
      salvageRun(f.root, f.id, f.dest, { confirm: true }),
    ).rejects.toThrow();
    expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
    expect(existsSync(join(f.dest, "FAILED.json"))).toBe(true);
    expect(hash(join(f.path, "input.log.jsonl"))).toBe(input);
    expect(hash(join(f.path, "perceptions.jsonl"))).toBe(data);
  });

test("zero valid frames preserve evidence without inventing a playable recording", async () => {
  const f = await fixture();
  writeFileSync(join(f.path, "perceptions.jsonl"), "garbage\n");
  const result = await salvageRun(f.root, f.id, f.dest, { confirm: true });
  expect(result.integrity.state).toBe("corrupt");
  expect(result.integrity.completeFrames).toBe(0);
  expect(result.review).toBeNull();
  expect(existsSync(join(f.dest, "review.nh-run.jsonl"))).toBe(false);
  expect(readFileSync(join(f.dest, "evidence/perceptions.jsonl"), "utf8")).toBe(
    "garbage\n",
  );
});

test("ambiguous duplicate-key checkpoints stop salvage; later good frames are not stitched across damage", async () => {
  const f = await fixture(),
    lines = f.prefix.trimEnd().split("\n");
  const bad = lines[1].replace('"sequence":1', '"sequence":999,"sequence":1');
  writeFileSync(
    join(f.path, "perceptions.jsonl"),
    lines[0] + "\n" + bad + "\n" + lines[1] + "\n",
  );
  const result = await salvageRun(f.root, f.id, f.dest, { confirm: true });
  expect(result.integrity.state).toBe("corrupt");
  expect(result.integrity.completeFrames).toBe(1);
  expect(
    parseRecording(readFileSync(join(f.dest, result.review!.file), "utf8")),
  ).toHaveLength(1);
});

test("salvage refuses missing confirmation, nested destinations, overwrites and complete journals", async () => {
  const f = await fixture();
  await expect(
    salvageRun(f.root, f.id, f.dest, { confirm: false }),
  ).rejects.toThrow("confirmation");
  await expect(
    salvageRun(f.root, f.id, join(f.path, "copy"), { confirm: true }),
  ).rejects.toThrow("outside");
  await salvageRun(f.root, f.id, f.dest, { confirm: true });
  const digest = hash(join(f.dest, "manifest.json"));
  await expect(
    salvageRun(f.root, f.id, f.dest, { confirm: true }),
  ).rejects.toThrow();
  expect(hash(join(f.dest, "manifest.json"))).toBe(digest);
  writeFileSync(join(f.path, "perceptions.jsonl"), f.prefix);
  await expect(
    salvageRun(f.root, f.id, f.dest + "-complete", { confirm: true }),
  ).rejects.toThrow("complete");
  expect(existsSync(f.dest + "-complete")).toBe(false);
});

test("unparseable private journals are preserved as evidence, never used to infer a repaired world", async () => {
  const f = await fixture();
  writeFileSync(join(f.path, "meta.json"), "{broken metadata");
  appendFileSync(
    join(f.path, "requests.seen.jsonl"),
    "{incomplete reservation",
  );
  appendFileSync(join(f.path, "input.log.jsonl"), "bad input");
  const before = tree(f.path),
    result = await salvageRun(f.root, f.id, f.dest, { confirm: true });
  expect(tree(f.path)).toEqual(before);
  for (const file of ["meta.json", "requests.seen.jsonl", "input.log.jsonl"])
    expect(hash(join(f.dest, "evidence", file))).toBe(hash(join(f.path, file)));
  expect(result.integrity.completeFrames).toBe(2);
  expect(result.liveRecovery).toBe(false);
});

test("a non-cooperating source-tree change leaves no completed salvage manifest", async () => {
  const f = await fixture();
  let watcher: ReturnType<typeof watch>;
  const changed = new Promise<void>((resolve) => {
    watcher = watch(join(f.dest, ".."), (_event, name) => {
      if (String(name) === basename(f.dest)) {
        writeFileSync(
          join(f.path, "external-change"),
          "not part of the original snapshot",
        );
        watcher.close();
        resolve();
      }
    });
  });
  try {
    await expect(
      salvageRun(f.root, f.id, f.dest, { confirm: true }),
    ).rejects.toThrow("changed");
    await changed;
    expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
    expect(existsSync(join(f.dest, "FAILED.json"))).toBe(true);
  } finally {
    watcher!.close();
  }
});

test("a missing lease is not created as an unlocked fallback", async () => {
  const f = await fixture();
  unlinkSync(join(f.path, ".lease"));
  const before = tree(f.path);
  await expect(
    salvageRun(f.root, f.id, f.dest, { confirm: true }),
  ).rejects.toThrow();
  expect(tree(f.path)).toEqual(before);
  expect(existsSync(f.dest)).toBe(false);
});

test("operator CLI copies but never executes a pinned artifact", async () => {
  const f = await fixture(),
    marker = join(testDirectory("salvage-marker"), "executed");
  unlinkSync(join(f.path, "engine")); // Never mutate the per-root pinned binary cache.
  writeFileSync(
    join(f.path, "engine"),
    `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
  );
  const p = Bun.spawn(
    ["bun", `${ROOT}/tools/salvage-run.ts`, f.root, f.id, f.dest, "--confirm"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, error, exit] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  expect(error).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(out).frames).toBe(2);
  expect(existsSync(marker)).toBe(false);
  expect(hash(join(f.path, "engine"))).toBe(
    hash(join(f.dest, "evidence/engine")),
  );
});
