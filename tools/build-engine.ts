// Bootstrap a fresh checkout, or incrementally rebuild an existing playground.
// Never run destructive `make install` over a populated game-data directory.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { copyFile, rename, access, readdir, stat } from "node:fs/promises";
const root = resolve(import.meta.dir, "..");
const upstream = resolve(root, "upstream");
const playground = resolve(upstream, "playground");
const lua =
  process.env.LUA_HOME ??
  resolve(homedir(), ".local/share/mise/installs/lua/5.4.9");
try {
  await access(`${lua}/include/lua.h`);
} catch {
  throw Error(
    `Missing Lua development files at ${lua}. Run mise install lua@5.4.9 or set LUA_HOME.`,
  );
}
async function run(command: string[], cwd = root) {
  const p = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await p.exited) throw Error(`Build failed: ${command.join(" ")}`);
}
const flags = [
  `LUA_MISE=${lua}`,
  `LUAHEADERS=${lua}/include`,
  "LUAHPREFIX=",
  `LUATOPLIB=${lua}/lib/liblua.a`,
  "LUALIB=",
  "LUALIBBUILT=",
  `LUALIBS=${lua}/lib/liblua.a -lm -ldl`,
  `LUACFLAGS=-I${lua}/include`,
  `HACKDIR=${playground}`,
  `INSTDIR=${playground}`,
  `VARDIR=${playground}`,
  "SHELLDIR=",
  "CHOWN=true",
  "CHGRP=true",
];
const generated = await stat(`${upstream}/src/Makefile`).catch(() => null);
const inputs = [
  "sys/unix/Makefile.src",
  "sys/unix/Makefile.top",
  "sys/unix/Makefile.dat",
  "sys/unix/Makefile.doc",
  "sys/unix/Makefile.utl",
  "sys/unix/setup.sh",
  "sys/unix/hints/headless.500",
  ...(await readdir(`${upstream}/sys/unix/hints/include`)).map(
    (name) => `sys/unix/hints/include/${name}`,
  ),
];
const timestamps = await Promise.all(
  inputs.map((path) => stat(`${upstream}/${path}`)),
);
if (!generated || timestamps.some((info) => info.mtimeMs > generated.mtimeMs)) {
  await run(
    ["sh", "sys/unix/setup.sh", "sys/unix/hints/headless.500"],
    upstream,
  );
}
if (!(await Bun.file(`${playground}/nhdat`).exists())) {
  const existing = await readdir(playground).catch(() => []);
  if (existing.length)
    throw Error(
      `Refusing to install over nonempty ${playground} without nhdat. Move or recover it explicitly first.`,
    );
  await run(["make", "-C", upstream, "-j4", ...flags]);
  await run(["make", "-C", upstream, "install", ...flags]);
} else {
  await run(["make", "-C", `${upstream}/src`, "-j4", "nethack", ...flags]);
  const destination = `${playground}/nethack`,
    temporary = `${destination}.new-${process.pid}`;
  await copyFile(`${upstream}/src/nethack`, temporary);
  await rename(temporary, destination);
}
console.log(
  "Native engine ready. Existing session directories and engine pins were not changed.",
);
