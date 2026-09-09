// Encyclopedia glossary for a chronicle. Terms come from the witnessed messages
// and are resolved by the pinned engine's `session.lookup`, so a dotted name in
// the story is reference lore for something the log mentioned, never an inferred
// identity. Words the model introduced on its own are not annotated.
export const MAX_LOOKUPS = 400;
export const MAX_TERMS = 48;
const STOP = new Set(
  "the a an and or but of to in on at by for with from into onto over under you your yours it its this that these those here there is are was were be been being have has had do does did not no yes very more most some any all each both few many much such own same so than too can will just now then when while where who whom which what how also only ever never again once still yet away back down up out off again about above below between through during before after around near far behind beside within without he she they them his her their we our us me my mine i am as if because until although though since like unlike toward towards against upon per via say says said hear hears heard see sees seen saw feel feels felt seem seems seemed thing things something nothing anything everything someone anyone everyone nobody one two three four five six seven eight nine ten first second third last next well badly quite rather really almost nearly slightly suddenly finally momentarily great effort".split(
    " ",
  ),
);
// The engine's typed lookup also accepts entry names contained in the query
// ("kobold hits" finds kobold). Candidates are therefore restricted to noun
// phrases: no verbs inside, and either introduced by a determiner/count or
// written as a proper name inside the sentence.
const VERBS = new Set(
  "hit hits miss misses bite bites kill kills killed die dies dying swap swaps place places eat eats eating ate finish finishes finished begin begins began feel feels hear hears see sees move moves moved open opens opened close closes closed pick picks picked drop drops dropped drink drinks drank read reads wield wields wear wears throw throws threw pull pulls pulled touch touches touched escape escapes cannot get gets got take takes took erupt erupts loosen loosens grip stumble stumbles trip trips fall falls fell land lands attack attacks satiate satiates stop stops start starts turn turns descend descends climb climbs enter enters leave leaves seem seems appear appears vanish vanishes wake wakes fight fights struggle struggles pray prays prayed praying rebel rebels rebelled steal steals stole is are was were has have had".split(
    " ",
  ),
);
const DETERMINERS = new Set(
  "a an the your its his her their some no this that these those another each every".split(
    " ",
  ),
);
const REMAINS = new Set(["corpse", "corpses", "statue", "statues", "figurine", "figurines", "egg", "eggs"]);
const PLURAL = (word) =>
  word.length > 4 && word.endsWith("ies")
    ? word.slice(0, -3) + "y"
    : word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)
      ? word.slice(0, -2)
      : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word;

/** Ordered, bounded candidate names from the witnessed messages (longest first). */
export function candidateTerms(digest) {
  const seen = new Set(),
    out = [];
  const consider = (words) => {
    const term = words.join(" "),
      singular = [...words.slice(0, -1), PLURAL(words.at(-1))].join(" ");
    for (const name of singular === term ? [term] : [singular, term])
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
  };
  const fragments = [];
  for (const event of digest.events ?? [])
    for (const message of event.messages ?? [])
      for (const sentence of String(message).split(
        /(?<=[.!?:;,])\s+|\s+[-–—]+\s+|\n+|[()"]/,
      )) {
        const tokens = sentence
          .replace(/[^A-Za-z0-9' -]+/g, " ")
          .split(/\s+/)
          .map((w) => w.replace(/^'+|'+$/g, ""))
          .filter(Boolean);
        // The opening legend is prose, not an incident: only its names count.
        if (tokens.length) fragments.push({ tokens, legend: event.action === "new_game" });
      }
  // A capitalised word inside a sentence is a name; at the start it is only a
  // name when the same word is also written that way elsewhere.
  const names = new Set();
  for (const { tokens } of fragments)
    tokens.forEach((t, i) => i > 0 && /^[A-Z][a-z]/.test(t) && names.add(t.toLowerCase()));
  for (const { tokens, legend } of fragments) {
    const words = tokens.map((w) => w.toLowerCase());
    const proper = (i) =>
      /^[A-Z][a-z]/.test(tokens[i]) && (i > 0 || names.has(words[i]));
    for (let n = 3; n >= 1; n--)
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        const introduced =
          !legend &&
          i > 0 &&
          (DETERMINERS.has(words[i - 1]) || /^\d+$/.test(words[i - 1]));
        if (
          gram.some(
            (w) => w.length < 3 || /\d/.test(w) || STOP.has(w) || VERBS.has(w),
          ) ||
          (n === 1 && gram[0].length < 4 && !proper(i)) ||
          !(introduced || gram.every((_, k) => proper(i + k)))
        )
          continue;
        consider(gram);
      }
  }
  return out.slice(0, MAX_LOOKUPS);
}

/** Resolve candidates through the engine. `lookup(name)` returns a LoreResponse. */
export async function buildGlossary(lookup, digest) {
  const glossary = {};
  const singular = (term) => {
    const words = term.split(" ");
    return [...words.slice(0, -1), PLURAL(words.at(-1))].join(" ");
  };
  const cache = new Map();
  const entry = async (name) => {
    if (cache.has(name)) return cache.get(name);
    let lines = null;
    try {
      const result = await lookup(name);
      if (result?.found && Array.isArray(result.lines) && result.lines.length) {
        lines = result.lines.map((l) => String(l).slice(0, 400)).slice(0, 80);
        if (!lines.join("\n").trim()) lines = null;
      }
    } catch {}
    cache.set(name, lines);
    return lines;
  };
  for (const term of candidateTerms(digest)) {
    if (Object.keys(glossary).length >= MAX_TERMS) break;
    // The singular form is looked up first; its plural then needs no entry.
    if (singular(term) !== term && glossary[singular(term)]) continue;
    const lines = await entry(term);
    if (!lines) continue;
    const words = term.split(" ");
    // "gnome corpse" finds gnome through containment; the remains are not the
    // creature. The bare creature name is still looked up on its own.
    if (words.length > 1 && REMAINS.has(words.at(-1))) continue;
    glossary[term] = { name: term, lines };
  }
  return glossary;
}

/** Split a paragraph into plain and glossary-linked segments (longest term wins). */
export function segment(text, glossary) {
  const terms = Object.keys(glossary ?? {}).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  if (!terms.length) return [{ text }];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?<![\\w'-])(${terms.map(escapeRe).join("|")})(?:e?s)?(?![\\w'-])`,
    "gi",
  );
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start) });
    const key =
      terms.find((t) => t === match[1].toLowerCase()) ??
      terms.find((t) => t === PLURAL(match[1].toLowerCase()));
    segments.push(key ? { text: match[0], term: key } : { text: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** Story paragraphs with segments attached; the glossary is trimmed to used terms. */
export function annotateStory(story, glossary) {
  const used = {};
  const paragraphs = story.paragraphs.map((p) => {
    const segments = segment(p.text, glossary);
    for (const s of segments) if (s.term && glossary[s.term]) used[s.term] = glossary[s.term];
    return { ...p, segments };
  });
  return { story: { ...story, paragraphs }, glossary: used };
}
