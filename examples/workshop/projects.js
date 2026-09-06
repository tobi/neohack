import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
export const botsRoot = resolve(repository, "web/neohack.dev/bots");
export const catalog = JSON.parse(
  await readFile(resolve(botsRoot, "examples.json"), "utf8"),
);

export function validateProject(files) {
  if (
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    !Object.hasOwn(files, "main.js")
  ) {
    throw Error("A workshop project needs main.js.");
  }
  const entries = Object.entries(files);
  if (
    entries.length > 20 ||
    !entries.every(
      ([name, code]) => /^[\w-]+\.js$/.test(name) && typeof code === "string",
    )
  ) {
    throw Error("Use up to 20 JavaScript files with simple .js filenames.");
  }
  if (JSON.stringify(files).length > 100000)
    throw Error("Workshop source exceeds 100 KB.");
  return { ...files };
}

export async function exampleProject(example) {
  const files = {};
  for (const [name, path] of Object.entries(example.files)) {
    files[name] = await readFile(resolve(botsRoot, path), "utf8");
  }
  return {
    name: example.name,
    description: example.description,
    files: validateProject(files),
  };
}

export async function loadProject(input) {
  const sample = catalog.find(
    (example) =>
      example.id === input ||
      [
        resolve(botsRoot, example.files["main.js"]),
        dirname(resolve(botsRoot, example.files["main.js"])),
      ].includes(resolve(input)),
  );
  if (sample) return exampleProject(sample);
  const path = resolve(input);
  const info = await stat(path);
  if (!info.isDirectory() && path.endsWith(".json")) {
    const saved = JSON.parse(await readFile(path, "utf8"));
    const source =
      typeof saved.artifact === "string" ? JSON.parse(saved.artifact) : saved;
    return {
      name: source.name ?? "Saved script",
      files: validateProject(source.files),
    };
  }
  const directory = info.isDirectory() ? path : dirname(path);
  if (!info.isDirectory() && !path.endsWith("/main.js"))
    throw Error(
      "Pass an example ID, a project directory, main.js, or exported source JSON.",
    );
  const files = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".js"))
      files[name] = await readFile(resolve(directory, name), "utf8");
  }
  return { name: "Local script", files: validateProject(files) };
}
