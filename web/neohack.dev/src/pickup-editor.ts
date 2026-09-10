import type { AutomaticPickup } from "neonethack/types";

export const pickupPreferenceKey = "neonethack.pixel.automatic-pickup.v1";
export const pickupTypes = ["gold", "food", "potions", "scrolls", "weapons", "armor", "rings", "amulets", "tools", "spellbooks", "wands", "gems", "rocks", "balls", "chains"] as const;
export const pickupDefaults = (): AutomaticPickup => ({enabled:true, itemTypes:["gold"], arrows:true, leaveCorpses:true, leaveKnownCursed:true});
const names: Record<typeof pickupTypes[number], string> = {gold:"Gold", food:"Food", potions:"Potions", scrolls:"Scrolls", weapons:"Weapons", armor:"Armor", rings:"Rings", amulets:"Amulets", tools:"Tools", spellbooks:"Spellbooks", wands:"Wands", gems:"Gems", rocks:"Rocks & statues", balls:"Iron balls", chains:"Chains"};

const patternError = "Use up to 16 nonblank patterns per list, each at most 64 UTF-8 bytes without control characters.";
// oxlint-disable-next-line no-control-regex -- Reject or strip control characters at this text boundary.
const validPatterns = (patterns:unknown):boolean => patterns === undefined || (Array.isArray(patterns) && patterns.length <= 16 && patterns.every(v => typeof v === "string" && !!v.trim() && new TextEncoder().encode(v).length <= 64 && !/[\u0000-\u001f\u007f]/.test(v)));

export function validPickup(value: unknown): value is AutomaticPickup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return Object.keys(p).every(k => ["enabled", "itemTypes", "arrows", "leaveCorpses", "leaveKnownCursed", "lootPatterns", "ignorePatterns", "review"].includes(k)) && ["enabled", "arrows", "leaveCorpses", "leaveKnownCursed"].every(k => typeof p[k] === "boolean")
    && Array.isArray(p.itemTypes) && p.itemTypes.length <= pickupTypes.length
    && new Set(p.itemTypes).size === p.itemTypes.length
    && p.itemTypes.every(t => pickupTypes.includes(t))
    && (p.review === undefined || typeof p.review === "boolean")
    && [p.lootPatterns, p.ignorePatterns].every(validPatterns);
}
export function loadPickupPreferences(): { settings: AutomaticPickup; rememberable: boolean } {
  try {
    const text = localStorage.getItem(pickupPreferenceKey);
    if (text) {
      try {
        const p = JSON.parse(text);
        if (p?.version === 1 && Object.keys(p).length === 2 && validPickup(p.settings))
          return {settings:p.settings, rememberable:true};
      } catch { /* Invalid preferences use the documented defaults. */ }
    }
    return {settings:pickupDefaults(), rememberable:true};
  } catch { return {settings:pickupDefaults(), rememberable:false}; }
}
export function rememberPickup(settings: AutomaticPickup): boolean {
  try { localStorage.setItem(pickupPreferenceKey, JSON.stringify({version:1, settings})); return true; }
  catch { return false; }
}
export function pickupSummary(p: AutomaticPickup): string {
  if (!p.enabled) return "Off";
  const categories = pickupTypes.filter(t => p.itemTypes.includes(t)).map(t => names[t]);
  if (p.arrows && !p.itemTypes.includes("weapons")) categories.push("arrows");
  if (p.lootPatterns?.length) categories.push(`${p.lootPatterns.length} loot patterns`);
  if (p.ignorePatterns?.length) categories.push(`${p.ignorePatterns.length} ignore patterns`);
  return categories.length ? categories.join(" + ") : "Nothing selected";
}

/** Local draft only. The owner explicitly saves it through the public API. */
export function pickupEditor(initial: AutomaticPickup, rememberable = true) {
  let draft = structuredClone(initial);
  const root = document.createElement("section"); root.className = "pickup-editor";
  root.setAttribute("aria-label", "Automatic pickup");
  const summary = document.createElement("p"); summary.className = "pickup-summary"; summary.setAttribute("aria-live", "polite");
  const help = document.createElement("p"); help.className = "subtle";
  help.textContent = "Collect selected items as you walk over them.";
  const toggles: {input: HTMLInputElement; read: () => boolean}[] = [];
  const patternInputs: {input:HTMLTextAreaElement;key:"lootPatterns"|"ignorePatterns"}[] = [];
  const update = () => { patternInputs.forEach(({input,key})=>{input.value=draft[key]?.join("\n") ?? "";input.setCustomValidity(validPatterns(draft[key]) ? "" : patternError);}); summary.textContent = pickupSummary(draft); toggles.forEach(t => { t.input.checked = t.read(); }); };
  const toggle = (label: string, read: () => boolean, write: (value: boolean) => void) => {
    const row = document.createElement("label"); row.className = "pickup-toggle";
    const input = document.createElement("input"); input.type = "checkbox";
    input.onchange = () => { write(input.checked); update(); };
    row.append(input, document.createTextNode(label)); toggles.push({input, read}); return row;
  };
  root.append(toggle("Review before collecting", () => draft.review === true, v => { draft.review = v; }));
  root.append(toggle("Automatic pickup", () => draft.enabled, v => { draft.enabled = v; }), help, summary);
  const categories = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = "Item types"; categories.append(legend);
  const primary = document.createElement("div"); primary.className = "pickup-types";
  const more = document.createElement("details");
  const moreTitle = document.createElement("summary"); moreTitle.textContent = "More item types"; more.append(moreTitle);
  const remaining = document.createElement("div"); remaining.className = "pickup-types"; more.append(remaining);
  pickupTypes.forEach((type, i) => {
    const row = toggle(names[type], () => draft.itemTypes.includes(type), checked => {
      draft.itemTypes = pickupTypes.filter(t => t === type ? checked : draft.itemTypes.includes(t));
    });
    (i < 5 ? primary : remaining).append(row);
  });
  const all = document.createElement("button"); all.type = "button"; all.className = "secondary"; all.textContent = "All types";
  all.onclick = () => { draft.itemTypes = [...pickupTypes]; update(); };
  categories.append(primary, more, all); root.append(categories);
  const patterns = document.createElement("fieldset"); patterns.className="pickup-patterns";
  const patternTitle=document.createElement("legend"); patternTitle.textContent="Match item names"; patterns.append(patternTitle);
  for(const [key,label] of [["lootPatterns","Loot patterns"],["ignorePatterns","Ignore patterns"]] as const) {
    const row=document.createElement("label"); row.textContent=label;
    const input=document.createElement("textarea"); input.rows=3; input.placeholder=key==='lootPatterns'?'ration\ndagger':'corpse\ncursed';
    input.oninput=()=>{draft[key]=input.value.split('\n').filter(s=>s.length>0);input.setCustomValidity(validPatterns(draft[key]) ? '' : patternError);summary.textContent=pickupSummary(draft);};
    row.append(input); patterns.append(row); patternInputs.push({input,key});
  }
  const patternHelp=document.createElement("p"); patternHelp.className="subtle";
  patternHelp.textContent="One substring per line, up to 16 per list. Matches ignore letter case and use only the item's known name. Ignore patterns and leave rules win over loot patterns and item types. These are literal text, not wildcards or regular expressions.";
  patterns.append(patternHelp); root.append(patterns);
  const rules = document.createElement("fieldset");
  const rulesTitle = document.createElement("legend"); rulesTitle.textContent = "Always apply these rules"; rules.append(rulesTitle);
  for (const [key, label] of [["arrows", "Also collect arrows"], ["leaveCorpses", "Leave corpses"], ["leaveKnownCursed", "Leave known cursed items"]] as const)
    rules.append(toggle(label, () => draft[key], v => { draft[key] = v; }));
  const precedence = document.createElement("p"); precedence.className = "subtle";
  precedence.textContent = "Leave rules take priority. Dropped, thrown and recovered items follow the same filters. Unknown curses stay unknown. Containers are opened manually.";
  rules.append(precedence); root.append(rules);
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "secondary"; reset.textContent = "Reset defaults";
  reset.onclick = () => { draft = pickupDefaults(); update(); }; root.append(reset);
  const note = document.createElement("p"); note.className = "subtle pickup-storage";
  note.textContent = rememberable ? "Remembered for new adventures in this browser. Other browsers and devices have their own preferences." : "Preferences cannot be remembered in this browser. You can still play with these settings.";
  root.append(note); update();
  return {element:root, value:() => { if(!validPickup(draft)) throw Error(patternError); return structuredClone(draft); }};
}
