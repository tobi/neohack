// Website names. The generated name is sent explicitly and retained with the
// run; rerolling never touches the engine's seed or random number generator.
const starts = ['Al','Bri','Cor','El','Fen','Is','Kel','Lin','Mar','Nor','Or','Ren','Syl','Tal','Val','Wyn'];
const endings = ['a','an','ara','en','ia','in','is','on','ora','ric','rin','wen'];
const families = ['Ashbrook','Bramble','Cinder','Fairwind','Fernwood','Flint','Foxglove','Hawthorn','Mossvale','Oakfall','Reedwater','Starling','Thistle','Willow'];
const names = starts.flatMap(start=>endings.flatMap(end=>families.map(family=>`${start}${end} ${family}`)));
const allowed = new Set(names);
export function adventurerName(previous = '') {
  const choices = names.filter(name=>name!==previous);
  return choices[crypto.getRandomValues(new Uint32Array(1))[0] % choices.length];
}
export function generatedName(value) { return typeof value === 'string' && allowed.has(value); }
/** Stable replacement for metadata submitted outside the generated-name UI. */
export function publicName(id, requested) {
  if (generatedName(requested)) return requested;
  let hash = 2166136261;
  for (const c of String(id)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return names[hash % names.length];
}
