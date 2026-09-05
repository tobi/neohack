import ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const input = resolve(root, '../../examples/wasm/neonethack.ts');
const options = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true,
  baseUrl: root, paths: { 'neonethack': ['typescript/client.ts'], 'neonethack/wasm': ['typescript/wasm.ts'] },
  typeRoots: [resolve(root, 'node_modules/@types')],
};
const program = ts.createProgram([input], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n' }));
  process.exit(1);
}
const { outputText } = ts.transpileModule(await readFile(input, 'utf8'), { compilerOptions: options });
await writeFile(input.replace(/\.ts$/, '.js'), outputText);
