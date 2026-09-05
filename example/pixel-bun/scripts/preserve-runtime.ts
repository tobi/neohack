import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Local build artifacts only: retain complete, immutable packages so rebuilding
// the preview cannot strand existing browser saves on a different engine.
export async function preserveRuntime() {
  const root = resolve(import.meta.dir, "..");
  const dist = resolve(root, "../../lib/neonethack/dist");
  const manifest = JSON.parse(
    await readFile(`${dist}/wasm/manifest.json`, "utf8"),
  );
  const hash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/.test(manifest.buildId) ||
    hash(JSON.stringify(manifest.files)) !== manifest.buildId
  )
    throw Error("Invalid runtime identity; no package was archived.");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      !/^[\w.-]+$/.test(name) ||
      hash(await readFile(`${dist}/wasm/${name}`)) !== digest
    )
      throw Error("Runtime integrity check failed; no package was archived.");
  }
  const registryPath = `${dist}/wasm-packages/index.json`;
  let registry: { legacyBuildId: string; currentBuildId: string };
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    registry = {
      legacyBuildId: manifest.buildId,
      currentBuildId: manifest.buildId,
    };
  }
  if (
    ![registry.legacyBuildId, registry.currentBuildId].every((id) =>
      /^[a-f0-9]{64}$/.test(id),
    )
  )
    throw Error("Runtime registry is damaged; it has not been replaced.");
  const archive = `${dist}/wasm-packages/${manifest.buildId}`;
  await mkdir(archive, { recursive: true });
  await cp(`${dist}/wasm`, archive, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  for (const [name, digest] of Object.entries(manifest.files))
    if (hash(await readFile(`${archive}/${name}`)) !== digest)
      throw Error("Archived runtime is damaged; it has not been replaced.");
  registry.currentBuildId = manifest.buildId;
  await writeFile(registryPath, JSON.stringify(registry) + "\n");
  await mkdir(`${root}/public/build`, { recursive: true });
  await writeFile(
    `${root}/public/build/runtime.json`,
    JSON.stringify(registry) + "\n",
  );
}
if (import.meta.main) await preserveRuntime();
