/** Filesystem state belongs to the pinned process, including open DLB offsets. */
export function captureFiles(module, { staticData = false } = {}) {
  const fs = module.FS,
    nodes = [];
  function walk(path) {
    const node = fs.lookupPath(path, { follow: false }).node;
    if (fs.isDir(node.mode)) {
      nodes.push({
        path,
        mode: node.mode,
        id: node.id,
        atime: node.atime,
        mtime: node.mtime,
        ctime: node.ctime,
      });
      for (const name of fs.readdir(path))
        if (name !== "." && name !== "..")
          walk(path === "/" ? "/" + name : path + "/" + name);
    } else if (fs.isFile(node.mode))
      nodes.push({
        path,
        mode: node.mode,
        id: node.id,
        atime: node.atime,
        mtime: node.mtime,
        ctime: node.ctime,
        ...(staticData && /^\/nh\/(nhdat|sysconf|symbols|license)$/.test(path)
          ? { static: true, size: fs.stat(path).size }
          : { data: fs.readFile(path) }),
      });
    else if (fs.isLink(node.mode))
      nodes.push({
        path,
        mode: node.mode,
        id: node.id,
        atime: node.atime,
        mtime: node.mtime,
        ctime: node.ctime,
        link: fs.readlink(path),
      });
  }
  walk("/");
  const streams = fs.streams
    .filter((s) => s && s.fd > 2)
    .map((s) => ({
      fd: s.fd,
      path: s.path,
      flags: s.flags,
      position: s.position,
    }));
  return { nodes, streams, nextInode: fs.nextInode, cwd: fs.cwd() };
}
export function restoreFiles(module, value) {
  const fs = module.FS;
  if (
    !value ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 10000 ||
    !Array.isArray(value.streams) ||
    value.streams.length > 1024 ||
    !Number.isSafeInteger(value.nextInode)
  )
    throw Error("Invalid checkpoint filesystem");
  let total = 0;
  const seen = new Set();
  for (const entry of value.nodes) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length > 4096 ||
      !entry.path.startsWith("/") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((s) => s === ".." || s === ".") ||
      seen.has(entry.path) ||
      !Number.isInteger(entry.mode) ||
      !Number.isSafeInteger(entry.id) ||
      !["atime", "mtime", "ctime"].every((k) => Number.isFinite(entry[k]))
    )
      throw Error("Invalid checkpoint node");
    seen.add(entry.path);
    if (fs.isFile(entry.mode)) {
      if (entry.static) {
        if (
          !/^\/nh\/(nhdat|sysconf|symbols|license)$/.test(entry.path) ||
          fs.stat(entry.path).size !== entry.size
        )
          throw Error("Pinned checkpoint data differs");
      } else if (
        !(entry.data instanceof Uint8Array) ||
        (total += entry.data.length) > 128 * 1024 * 1024
      )
        throw Error("Invalid checkpoint file");
    } else if (fs.isLink(entry.mode)) {
      if (
        typeof entry.link !== "string" ||
        entry.link.length > 4096 ||
        entry.link.includes("\0")
      )
        throw Error("Invalid checkpoint link");
    } else if (!fs.isDir(entry.mode))
      throw Error("Invalid checkpoint node type");
  }
  for (const entry of value.streams)
    if (
      !Number.isSafeInteger(entry.fd) ||
      entry.fd < 3 ||
      entry.fd > 65535 ||
      !seen.has(entry.path) ||
      !Number.isSafeInteger(entry.flags) ||
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0
    )
      throw Error("Invalid checkpoint stream");
  for (const stream of [...fs.streams])
    if (stream && stream.fd > 2) fs.close(stream);
  for (const entry of value.nodes) {
    if (fs.isDir(entry.mode)) fs.mkdirTree(entry.path);
    else if (fs.isFile(entry.mode)) {
      if (!entry.static) fs.writeFile(entry.path, entry.data);
    } else if (fs.isLink(entry.mode)) {
      try {
        fs.unlink(entry.path);
      } catch {}
      fs.symlink(entry.link, entry.path);
    }
    const node = fs.lookupPath(entry.path, { follow: false }).node;
    node.mode = entry.mode;
    node.id = entry.id;
  }
  for (const entry of value.streams) {
    const stream = fs.open(entry.path, entry.flags & ~(64 | 128 | 512));
    if (stream.fd !== entry.fd) {
      fs.closeStream(stream.fd);
      stream.fd = entry.fd;
      fs.streams[entry.fd] = stream;
    }
    stream.position = entry.position;
  }
  for (const entry of value.nodes) {
    const node = fs.lookupPath(entry.path, { follow: false }).node;
    node.atime = entry.atime;
    node.mtime = entry.mtime;
    node.ctime = entry.ctime;
  }
  fs.nextInode = value.nextInode;
  fs.chdir(value.cwd);
}
