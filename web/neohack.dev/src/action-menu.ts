import { LitElement, html, nothing } from "lit";
import { describeCommand, type CommandIntent } from "./command-input";
import { fuzzyMatch } from "./fuzzy-match";

// Presentation and keyboard bindings share one vocabulary. The engine still
// supplies eligibility, elapsed turns and any subsequent item/target decision.
export const gameActions = [
  { id: "search", label: "Search nearby", key: "s" },
  { id: "wait", label: "Wait one turn", key: "." },
  { id: "rest", label: "Rest one turn", key: "" },
  { id: "pickup", label: "Pick up", key: "," },
  { id: "eat", label: "Eat", key: "e" },
  { id: "drink", label: "Drink", key: "q" },
  { id: "read", label: "Read", key: "r" },
  { id: "apply", label: "Use a tool", key: "a" },
  { id: "wield", label: "Wield", key: "w" },
  { id: "equip", label: "Wear equipment", key: "" },
  { id: "remove", label: "Remove equipment", key: "" },
  { id: "drop", label: "Drop", key: "d" },
  { id: "zap", label: "Zap a wand", key: "z" },
  { id: "throw", label: "Throw", key: "t" },
  { id: "fire", label: "Fire readied ammunition", key: "f" },
  { id: "cast", label: "Cast a spell", key: "Z" },
  { id: "quiver", label: "Ready ammunition", key: "Q" },
  { id: "enhance", label: "Improve skills", key: "" },
  { id: "twoWeapon", label: "Use two weapons", key: "" },
  { id: "move", label: "Move one step", key: "" },
  { id: "moveWithoutAttack", label: "Move without pickup or fighting", key: "" },
  { id: "attack", label: "Force attack", key: "" },
  { id: "run", label: "Run in a direction", key: "" },
  { id: "swap", label: "Swap weapons", key: "x" },
  { id: "open", label: "Open a door", key: "o" },
  { id: "close", label: "Close a door", key: "c" },
  { id: "kick", label: "Kick", key: "" },
  { id: "loot", label: "Open container", key: "" },
  { id: "up", label: "Climb up stairs", key: "<" },
  { id: "down", label: "Climb down stairs", key: ">" },
  { id: "auto:explore", label: "auto:explore", key: "v" },
  { id: "auto:descend", label: "auto:descend", key: "" },
  { id: "pay", label: "Pay the shopkeeper", key: "p" },
  { id: "chat", label: "Chat", key: "" },
  { id: "engrave", label: "Engrave", key: "E" },
  { id: "pray", label: "Pray", key: "" },
  { id: "offer", label: "Offer a sacrifice", key: "" },
  { id: "dip", label: "Dip an item", key: "" },
  { id: "rub", label: "Rub an item", key: "" },
  { id: "invoke", label: "Invoke an item", key: "" },
] as const;

function commandLabel(intent: CommandIntent): string {
  if (intent.kind === "search" || intent.kind === "rest")
    return `${intent.kind === "search" ? "Search nearby" : "Rest"} · up to ${intent.turns} turn${intent.turns === 1 ? "" : "s"}`;
  if (intent.kind === "run")
    return `Run ${intent.direction}${intent.mode === "pastBranches" ? " past forks" : intent.mode === "untilInteresting" ? " · stop at forks" : ""}${intent.noPickup ? " · no pickup or fighting" : ""}`;
  return `${intent.kind === "attack" ? "Force attack" : "Move"} ${intent.direction}${intent.kind === "moveWithoutAttack" ? " · no pickup or fighting" : ""}`;
}

export type MenuAction = { id: string; label: string; key?: string; aliases?: string; reason?: string; run: () => void };
type MenuOptions = {
  extra?: MenuAction[];
  unavailable: (action: string) => string;
  action: (action: string) => void;
  command: (intent: CommandIntent) => void;
};
export type ActionChoices = {
  title: string;
  about?: string;
  rows: {id: string; label: string; icon?: string}[];
  choose: (id: string) => void;
  back?: () => void;
};
type Match = { score?: number; label: string; key: string; run: () => void; reason?: string; action?: string; item?: string; icon?: string; positions?: number[] };

function highlighted(label: string, positions: number[] = []) {
  if (!positions.length) return label;
  const letters = Array.from(label), selected = new Set(positions), parts = [];
  for (let start = 0; start < letters.length;) {
    const marked = selected.has(start);
    let end = start + 1;
    while (end < letters.length && selected.has(end) === marked) end++;
    const text = letters.slice(start, end).join("");
    parts.push(marked ? html`<mark>${text}</mark>` : text);
    start = end;
  }
  return parts;
}

/** Light DOM keeps native dialog labeling, focus and shared control styles intact. */
export class ActionMenu extends LitElement {
  static properties = { options: {attribute:false}, query: {state:true}, active: {state:true}, choices: {state:true}, disabled: {type:Boolean} };
  declare options: MenuOptions;
  declare choices: ActionChoices | undefined;
  declare disabled: boolean;
  declare private query: string;
  declare private active: number;
  private rootSelection = {query: "", active: 0};
  constructor() { super(); this.query = ""; this.active = 0; this.disabled = false; }
  protected createRenderRoot() { return this; }
  private get matchingActions(): Match[] {
    if (!this.options) return [];
    const query = this.query.trim().replace(/^#/, ""), lower = query.toLowerCase(), matches: Match[] = [];
    const choices = this.choices;
    if (choices) return choices.rows.map(row => ({row, match:fuzzyMatch(this.query, row.label)}))
      .filter(entry => entry.match !== null).sort((a,b) => b.match!.score - a.match!.score)
      .map(({row,match}) => ({label:row.label, key:"", item:row.id, icon:row.icon, positions:match!.positions, run:()=>choices.choose(row.id)}));
    if (query) {
      const draft = describeCommand(query);
      // Preserve ordinary shortcut semantics: '.' waits; a count explicitly rests.
      const shortcut = gameActions.some(action => action.key === query);
      if (draft.intent && !shortcut) matches.push({label:commandLabel(draft.intent),key:query,run:()=>this.options.command(draft.intent!)});
      else if (!draft.error && !draft.intent) for (const hint of draft.hints) {
        const command = describeCommand(hint.value);
        matches.push({label:command.intent ? commandLabel(command.intent) : hint.label, key:hint.value,
          run:()=> { if(command.intent) this.options.command(command.intent); else this.search(hint.value); }});
      }
    }
    const actions = gameActions.map(action => {
      const label = fuzzyMatch(query, action.label), alias = fuzzyMatch(query, action.id);
      return {action, positions:label?.positions, score:!query ? 0 : action.key === query ? 1000000 : action.id === lower ? 100000 : Math.max(label?.score ?? -Infinity,alias ? alias.score - 10000 : -Infinity)};
    }).filter(entry => entry.score !== -Infinity).sort((a,b) => b.score - a.score);
    for(const {action,positions,score} of actions) matches.push({score,label:action.label,key:action.key || "#"+action.id,positions,
      action:action.id,reason:this.options.unavailable(action.id),run:()=>this.options.action(action.id)});
    for (const entry of this.options.extra ?? []) {
      const label = fuzzyMatch(query, entry.label), alias = fuzzyMatch(query, entry.aliases ?? entry.id);
      if (label || alias) matches.push({score:!query ? 0 : entry.key === query ? 1000000 : entry.id === lower ? 100000 : Math.max(label?.score ?? -Infinity,alias ? alias.score - 10000 : -Infinity),label:entry.label, key:entry.key ?? "", action:entry.id, reason:entry.reason, positions:label?.positions, run:entry.run});
    }
    return matches.sort((a,b)=>(b.score ?? 2000000)-(a.score ?? 2000000));
  }
  showChoices(choices: ActionChoices) {
    if (!this.choices) this.rootSelection = {query:this.query, active:this.active};
    this.choices = choices; this.search(""); void this.focusSearch();
  }
  showActions() {
    this.choices = undefined; this.query = this.rootSelection.query; this.active = this.rootSelection.active;
    void this.focusSearch();
    void this.updateComplete.then(() => this.querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"}));
  }
  private search(query: string) {
    this.query = query; this.active = 0;
    void this.updateComplete.then(() => {this.querySelector("#more-grid")?.scrollTo(0,0);});
  }
  private key(event: KeyboardEvent) {
    if (this.disabled || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      const count = this.matchingActions.length;
      if (count) {
        this.active = (this.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        void this.updateComplete.then(() => this.querySelector(`[aria-selected="true"]`)?.scrollIntoView({block:"nearest"}));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();event.stopPropagation();
      // Enter confirms the visible selection. Never substitute another action
      // when the exact match is unavailable or the opening revision went stale.
      if (!event.repeat) this.querySelector<HTMLButtonElement>(`#action-match-${this.active}`)?.click();
    }
  }
  async focusSearch() {
    await this.updateComplete;
    if(this.isConnected) this.querySelector<HTMLInputElement>("input")!.focus({preventScroll:true});
  }
  protected render() {
    const matches = this.matchingActions;
    const choices = this.choices;
    return html`<header><h2 id="menu-title">${choices ? html`<button type="button" class="action-back" aria-label="Back to actions" aria-keyshortcuts="Escape" ?disabled=${this.disabled || !choices.back} @click=${()=>choices.back?.()}>←</button>${choices.title}` : html`More actions <kbd>Ctrl K / #</kbd>`}</h2>
      ${choices?.about ? html`<p class="action-about">${choices.about}</p>` : nothing}
      <label class="sr-only" for="action-query">${choices ? "Search choices" : "Search actions or type a command"}</label>
      <input id="action-query" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="more-grid" aria-describedby="action-help"
        aria-activedescendant=${matches.length ? `action-match-${this.active}` : nothing}
        .value=${this.query} @input=${(event:InputEvent)=>{if(!event.isComposing)this.search((event.target as HTMLInputElement).value);}}
        @compositionend=${(event:CompositionEvent)=>this.search((event.target as HTMLInputElement).value)} @keydown=${this.key}
        placeholder=${choices ? "Search by name…" : "Search actions or type 20s, 20., mh…"} autocomplete="off" autocapitalize="off" spellcheck="false">
      </header><div id="more-grid" role="listbox" aria-label=${choices ? "Matching choices" : "Matching actions"}>${matches.map((match,index)=>html`
        <button type="button" role="option" tabindex="-1" id=${`action-match-${index}`} aria-selected=${index === this.active}
          aria-label=${match.label + (match.reason ? ": " + match.reason : "")} ?disabled=${this.disabled || !!match.reason} data-operation data-unavailable=${match.reason ?? ""}
          data-action=${match.action ?? nothing} data-item=${match.item ?? nothing} @pointermove=${()=>{this.active=index;}} @click=${()=>{if(!this.disabled)match.run();}}>
          ${match.icon ? html`<img class="action-item-icon" src=${match.icon} alt="">` : nothing}
          <span class="action-label">${highlighted(match.label,match.positions)}${match.reason ? html`<small>${match.reason}</small>` : nothing}</span>${match.key ? html`<kbd aria-hidden="true">${match.key}</kbd>` : nothing}
        </button>`)}</div>
      <p id="action-empty" ?hidden=${!!matches.length}>${choices ? "No matching choices." : "No matching actions."}</p>
      <footer><span id="action-count" role="status">${matches.length} match${matches.length===1 ? "" : "es"}</span><span id="action-help">↑ ↓ choose · Enter try · ${choices ? choices.back ? "Esc back" : "Answer required" : "Esc close"}</span></footer>`;
  }
}
customElements.define("neohack-action-menu", ActionMenu);

export function actionMenu(options: MenuOptions) {
  const element = document.createElement("neohack-action-menu") as ActionMenu;
  element.className = "action-picker"; element.options = options;
  return {element, focus:()=>void element.focusSearch()};
}
