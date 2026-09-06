#!/usr/bin/env node
import { parseArgs } from "node:util";
import { catalog } from "./projects.js";
import { runProject } from "./runtime.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      list: { type: "boolean" },
      json: { type: "boolean" },
      seed: { type: "string", default: "42" },
      calls: { type: "string", default: "1000" },
      timeout: { type: "string", default: "30000" },
      trace: { type: "string" },
    },
  });
  if (values.help || (!values.list && !positionals.length)) {
    console.log(`Run the same JavaScript as the web workshop against the native engine.

node examples/workshop/run.js <example|folder|main.js|source.json> [options]
  --list            List examples
  --seed 42         Reproducible game seed (human Valkyrie)
  --calls 1000      Maximum script API calls
  --timeout 30000   Script wall-clock limit in milliseconds
  --trace PATH      Write full public requests/results to a new JSONL file
  --json            Print one JSON summary, including the last 100 script logs

Build first: npm run --prefix lib/neonethack build && make -C lib/neonethack test`);
  } else if (values.list) {
    for (const example of catalog)
      console.log(`${example.id.padEnd(18)} ${example.description}`);
  } else {
    if (positionals.length !== 1)
      throw Error("Pass one example or project path.");
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const result = await runProject(positionals[0], {
      seed: Number(values.seed),
      calls: Number(values.calls),
      timeout: Number(values.timeout),
      trace: values.trace,
      signal: controller.signal,
      log: (text) => {
        if (!values.json) console.error(text);
      },
    });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (values.json) console.log(JSON.stringify(result));
    else {
      console.log(
        `${result.name}: ${result.reason} · seed ${result.seed} · turn ${result.turn} · ${result.calls} calls`,
      );
      console.log(
        `${result.moves} moves · ${result.uniqueSquares} squares visited · ${result.knownSquares} known · ${result.levels.join(" → ")}`,
      );
      if (result.error) console.error(result.error);
    }
    process.exitCode = ["error", "uncertain"].includes(result.reason)
      ? 1
      : ["timeout", "interrupted"].includes(result.reason)
        ? 2
        : 0;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
