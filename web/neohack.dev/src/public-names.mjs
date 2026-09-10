/** Operator presentation corrections never rewrite engine inputs or receipts. */
export function displayText(text, correction) {
  const value = String(text ?? '');
  if (!correction || typeof correction.original !== 'string' || !correction.original || correction.original.length > 64 ||
      typeof correction.name !== 'string' || !/^[A-Za-z][A-Za-z ]{0,63}$/.test(correction.name)) return value;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const original = correction.original, given = original.split(' ')[0];
  let result = value.replace(new RegExp(escape(original), 'gi'), () => correction.name);
  if (given.length > 1 && given !== original)
    result = result.replace(new RegExp('(?<![\\p{L}\\p{N}])' + escape(given) + '(?![\\p{L}\\p{N}])', 'giu'), () => correction.name.split(' ')[0]);
  return result;
}
export function displayDocument(value, correction) {
  if (!correction) return value;
  if (typeof value === 'string') return displayText(value, correction);
  if (Array.isArray(value)) return value.map(v => displayDocument(v, correction));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,displayDocument(v,correction)]));
  return value;
}
