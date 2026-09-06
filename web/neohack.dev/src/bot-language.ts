import ts from 'typescript';
// Built from the library's emitted declarations and this compiler's standard libs.
declare const __BOT_TYPES__: Record<string, string>;
const sources = new Map(Object.entries(__BOT_TYPES__));
const versions = new Map<string, number>();
const snapshots = new Map<string, ts.IScriptSnapshot>();
let project: string[] = [];
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true,
  lib: ['lib.es2022.d.ts'], types: [],
};
const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...project, '/types/client.d.ts'],
  getScriptVersion: name => String(versions.get(name) ?? 0),
  getScriptSnapshot: name => {
    const text = sources.get(name); if (text === undefined) return undefined;
    if (!snapshots.has(name)) snapshots.set(name, ts.ScriptSnapshot.fromString(text));
    return snapshots.get(name);
  },
  getCurrentDirectory: () => '/project', getDefaultLibFileName: () => '/lib/lib.es2022.d.ts',
  fileExists: name => sources.has(name), readFile: name => sources.get(name),
  readDirectory: () => [], directoryExists: name => ['/project', '/types', '/lib'].includes(name),
  resolveModuleNames: (names, from) => names.map(name => {
    if (name === 'neonethack') return { resolvedFileName: '/types/client.d.ts', extension: ts.Extension.Dts };
    if (!name.startsWith('./')) return undefined;
    const base = from.slice(0, from.lastIndexOf('/') + 1) + name.slice(2);
    const path = [base, base.replace(/\.js$/, '.d.ts'), base + '.ts', base + '.js'].find(p => sources.has(p));
    return path ? { resolvedFileName: path, extension: path.endsWith('.d.ts') ? ts.Extension.Dts : path.endsWith('.ts') ? ts.Extension.Ts : ts.Extension.Js } : undefined;
  }),
};
const service = ts.createLanguageService(host);
self.onmessage = event => {
  const { id, kind, files, file, position, name } = event.data;
  try {
    const paths = Object.keys(files).map(n => '/project/' + n);
    for (const path of project) if (!paths.includes(path)) { sources.delete(path); snapshots.delete(path); versions.set(path, (versions.get(path) ?? 0) + 1); }
    project = paths;
    for (const [name, text] of Object.entries(files) as [string, string][]) {
      const path = '/project/' + name;
      if (sources.get(path) !== text) { sources.set(path, text); snapshots.delete(path); versions.set(path, (versions.get(path) ?? 0) + 1); }
    }
    const path = '/project/' + file;
    let result: unknown;
    if (kind === 'complete') {
      result = service.getCompletionsAtPosition(path, position, { includeCompletionsForModuleExports: false })?.entries.map(e => ({ name: e.name, kind: e.kind, sortText: e.sortText }));
    } else if (kind === 'detail') {
      const detail = service.getCompletionEntryDetails(path, position, name, {}, undefined, undefined, undefined);
      result = detail ? { signature: ts.displayPartsToString(detail.displayParts), docs: ts.displayPartsToString(detail.documentation) } : null;
    } else if (kind === 'hover') {
      const info = service.getQuickInfoAtPosition(path, position);
      result = info ? { from: info.textSpan.start, to: info.textSpan.start + info.textSpan.length, signature: ts.displayPartsToString(info.displayParts), docs: ts.displayPartsToString(info.documentation) } : null;
    } else {
      result = [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)].filter(d => d.start !== undefined).map(d => ({ from: d.start!, to: d.start! + (d.length ?? 0), severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning', message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
    }
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
