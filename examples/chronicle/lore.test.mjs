import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateTerms, buildGlossary, segment, annotateStory } from "./lore.mjs";
import { renderStory } from "./prompt.mjs";
import { chronicleDocument } from "./generate.mjs";

// Synthetic evidence: these events did not occur in NetHack; they exercise the
// noun-phrase filter and the containment behaviour of the engine's lookup.
const digest = {
  version: 1,
  hero: { name: "Edda", role: "valkyrie" },
  coverage: { observedReplies: 4, complete: true, ignoredObservationsOrOldReceipts: 0, selectedEvents: 3, omittedReplies: 0, repeatedMessages: 0, startsAtCreation: true },
  events: [
    { id: "e1", turn: 1, action: "new_game", messages: ["It is written in the Book of Tyr: for the sake of Marduk, the cruel god Moloch rebelled. Moloch stole the Amulet."] },
    { id: "e2", turn: 5, messages: ["You swap places with your little dog.", "The gnome lord hits!", "You see here a gnome corpse.", "$ - 2 gold pieces."] },
    { id: "e3", turn: 9, messages: ["You die..."], ending: { kind: "death", cause: "killed by a gnome lord", turn: 9 } },
  ],
};
// A lookup that behaves like the engine: exact names, plus any entry name
// contained in the typed query.
const entries = { tyr: ["Tyr lore"], marduk: ["Marduk lore"], moloch: ["Moloch lore"], sake: ["Rice wine"], bell: ["Bells"], dog: ["Dog lore"], gnome: ["Gnome lore"], "gnome lord": ["Gnome lore"], lord: ["Ranks"], "gold piece": ["Gold lore"], gold: ["Gold lore"] };
const lookup = async (name) => {
  const q = name.toLowerCase();
  const hit = entries[q] ?? Object.entries(entries).find(([k]) => q.includes(k))?.[1];
  return { kind: "lore", found: !!hit, lines: hit ?? [] };
};

test("candidates are noun phrases from incidents plus proper names from the legend", () => {
  const terms = candidateTerms(digest);
  assert.ok(terms.includes("little dog"));
  assert.ok(terms.includes("gnome lord"));
  assert.ok(terms.includes("gold piece"), "count-introduced plural is singularised");
  assert.ok(terms.includes("tyr") && terms.includes("marduk") && terms.includes("moloch"));
  assert.ok(!terms.includes("sake"), "legend prose only contributes proper names");
  assert.ok(!terms.includes("rebelled") && !terms.includes("moloch rebelled"), "verbs never join a name");
  assert.ok(!terms.includes("swap places"));
});

test("glossary drops remains and plural duplicates; segments prefer the longest name", async () => {
  const glossary = await buildGlossary(lookup, digest);
  assert.deepEqual(Object.keys(glossary).sort(), ["gnome", "gnome lord", "gold", "gold piece", "little dog", "marduk", "moloch", "tyr"]);
  assert.ok(!("lord" in glossary), "a word inside a longer name is not a name of its own");
  const text = "The Gnome Lord hit her twice; her little dog, two gold pieces and Tyr all watched. A gnome came by.";
  const segments = segment(text, glossary);
  assert.deepEqual(segments.filter((s) => s.term).map((s) => [s.text, s.term]), [
    ["Gnome Lord", "gnome lord"], ["little dog", "little dog"], ["gold pieces", "gold piece"], ["Tyr", "tyr"], ["gnome", "gnome"],
  ]);
  assert.equal(segments.map((s) => s.text).join(""), text, "segments reassemble the paragraph exactly");
  const story = { title: "Edda", paragraphs: [{ text, sources: ["e2"] }, { text: "She died.", sources: ["e3"] }] };
  const annotated = annotateStory(story, glossary);
  assert.deepEqual(Object.keys(annotated.glossary).sort(), ["gnome", "gnome lord", "gold piece", "little dog", "tyr"], "unused entries are not shipped");
  const document = chronicleDocument({ digest, story, glossary });
  assert.equal(document.story.paragraphs[0].segments.length, segments.length);
  const html = renderStory(document.story, digest, document.model, document.glossary);
  assert.match(html, /<a class="lore" href="#lore-gnome-lord"[^>]*>Gnome Lord<\/a>/);
  assert.match(html, /<dt id="lore-little-dog">little dog<\/dt>/);
  assert.ok(!html.includes("Ranks"), "an unused glossary entry is not rendered");
});

test("hostile names in messages and lore stay text", async () => {
  const hostile = { ...digest, events: [{ ...digest.events[1], messages: ["You see here a <script>alert(1)</script> dog."] }, digest.events[2]] };
  const glossary = await buildGlossary(async () => ({ kind: "lore", found: true, lines: ['<img src=x onerror="1">'] }), hostile);
  const story = { title: "t", paragraphs: [{ text: "A dog.", sources: ["e2"] }, { text: "End.", sources: ["e3"] }] };
  const document = chronicleDocument({ digest: hostile, story, glossary });
  const html = renderStory(document.story, hostile, document.model, document.glossary);
  assert.ok(!html.includes("<img") && !html.includes("<script>"));
});
