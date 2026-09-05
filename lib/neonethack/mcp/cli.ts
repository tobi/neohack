#!/usr/bin/env node
import { serveStdio } from "./server.js";
const [enginePath, dataPath, sessionsPath] = process.argv.slice(2);
if (!enginePath || !dataPath || !sessionsPath) {
  console.error("usage: neonethack-mcp ENGINE DATA SESSIONS\nSet NEONETHACK_EXECUTABLE if the native bridge is not on PATH.");
  process.exitCode = 2;
} else {
  await serveStdio({ enginePath, dataPath, sessionsPath, executable: process.env.NEONETHACK_EXECUTABLE });
}
