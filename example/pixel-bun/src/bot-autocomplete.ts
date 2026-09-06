import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { hoverTooltip } from '@codemirror/view';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';

/** One TypeScript language service per workshop, with the complete virtual project. */
export function botLanguage(project: () => { files: Record<string, string>; file: string }) {
  const worker = new Worker('/build/bot-language.js', { type: 'module' });
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const request = (kind: string, position = 0, name?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, position, name, ...project() });
  });
  worker.onmessage = event => {
    const p = pending.get(event.data.id); if (!p) return; pending.delete(event.data.id);
    event.data.error ? p.reject(Error(event.data.error)) : p.resolve(event.data.result);
  };
  worker.onerror = event => { for (const p of pending.values()) p.reject(Error(event.message)); pending.clear(); };
  window.addEventListener('pagehide', () => { worker.terminate(); for (const p of pending.values()) p.reject(Error('Editor closed')); pending.clear(); }, { once: true });
  function documentation(info: { signature: string; docs: string }) {
    const dom = document.createElement('div'); dom.className = 'bot-type-info';
    const code = document.createElement('pre'); code.textContent = info.signature; dom.append(code);
    if (info.docs) { const p = document.createElement('p'); p.textContent = info.docs; dom.append(p); }
    return dom;
  }
  return [
    autocompletion({ override: [async (context: CompletionContext) => {
      const word = context.matchBefore(/[\w$]*/);
      if (!context.explicit && !word?.text && context.state.doc.sliceString(context.pos - 1, context.pos) !== '.') return null;
      const file = project().file;
      const entries = await request('complete', context.pos).catch(() => null);
      if (!entries || context.aborted || project().file !== file) return null;
      return { from: word?.from ?? context.pos, validFor: /^[\w$]*$/, options: entries.map((entry: { name: string; kind: string }) => ({
        label: entry.name, type: ({ method: 'method', function: 'function', property: 'property', 'enum member': 'enum', class: 'class', enum: 'enum', const: 'constant' } as Record<string, string>)[entry.kind] ?? 'variable',
        info: async () => { const detail = await request('detail', context.pos, entry.name).catch(() => null); return detail ? documentation(detail) : null; },
      })) };
    }] }),
    hoverTooltip(async (view, pos) => {
      const doc = view.state.doc, file = project().file;
      const info = await request('hover', pos).catch(() => null);
      if (!info || view.state.doc !== doc || project().file !== file) return null;
      return { pos: info.from, end: info.to, create: () => ({ dom: documentation(info) }) };
    }),
    lintGutter(),
    linter(async view => {
      const doc = view.state.doc, file = project().file;
      const diagnostics: Diagnostic[] = await request('diagnostics').catch(() => []);
      return doc === view.state.doc && file === project().file ? diagnostics : [];
    }, { delay: 500 }),
  ];
}
