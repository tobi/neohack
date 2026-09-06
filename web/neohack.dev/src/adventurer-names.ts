// UI suggestions only. The chosen name is sent explicitly and retained with the
// run; rerolling never touches the engine's seed or random number generator.
const starts = ['Al','Bri','Cor','El','Fen','Is','Kel','Lin','Mar','Nor','Or','Ren','Syl','Tal','Val','Wyn'];
const endings = ['a','an','ara','en','ia','in','is','on','ora','ric','rin','wen'];
const families = ['Ashbrook','Bramble','Cinder','Fairwind','Fernwood','Flint','Foxglove','Hawthorn','Mossvale','Oakfall','Reedwater','Starling','Thistle','Willow'];
export function adventurerName(previous = ''): string {
  const names = starts.flatMap(start=>endings.flatMap(end=>families.map(family=>`${start}${end} ${family}`))).filter(name=>name!==previous);
  return names[crypto.getRandomValues(new Uint32Array(1))[0]! % names.length]!;
}
