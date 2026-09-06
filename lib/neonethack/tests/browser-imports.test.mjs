import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { tools, compactResponseSchema } from "../dist/mcp/tools.js";

test("browser runtime module graph needs no JSON import attributes", async () => {
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      assert.equal(statement.attributes, undefined, url.pathname);
      const specifier = statement.moduleSpecifier?.text;
      if (specifier?.startsWith(".")) await visit(new URL(specifier, url));
    }
  }
  for (const entry of ["client", "wasm", "webmcp", "reference-client", "public-trace"]) {
    await visit(new URL("../dist/typescript/" + entry + ".js", import.meta.url));
  }
  assert.ok([...visited].some(path => path.endsWith("/mcp/tools.js")));
});

test("browser tool schemas match the published JSON", async () => {
  const catalog = JSON.parse(await readFile(new URL("../protocol/catalog.json", import.meta.url)));
  const response = JSON.parse(await readFile(new URL("../protocol/mcp-response.schema.json", import.meta.url)));
  assert.deepEqual(compactResponseSchema, response);
  assert.equal(tools.length, catalog.methods.length);
  for (const [index, tool] of tools.entries()) {
    assert.deepEqual(tool.inputSchema, catalog.methods[index].schema);
    assert.equal("outputSchema" in tool, false, "response schema is published once, outside discovery");
  }
});
