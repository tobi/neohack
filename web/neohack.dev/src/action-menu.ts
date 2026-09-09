import { LitElement, html, nothing } from "lit";
import { describeCommand, type CommandIntent } from "./command-input";

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
  { id: "swap", label: "Swap weapons", key: "x" },
  { id: "open", label: "Open a door", key: "o" },
  { id: "close", label: "Close a door", key: "c" },
  { id: "kick", label: "Kick", key: "" },
  { id: "loot", label: "Open container", key: "" },
  { id: "up", label: "Climb up stairs", key: "<" },
  { id: "down", label: "Climb down stairs", key: ">" },
  { id: "pay", label: "Pay the shopkeeper", key: "p" },
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

type MenuOptions = {
  unavailable: (action: string) => string;
  action: (action: string) => void;
  command: (intent: CommandIntent) => void;
};
type Match = { label: string; key: string; run: () => void; reason?: string; action?: string };

/** Light DOM keeps native dialog labeling, focus and shared control styles intact. */
export class ActionMenu extends LitElement {
  static properties = { options: {attribute:false}, query: {state:true}, active: {state:true} };
  declare options: MenuOptions;
  declare private query: string;
  declare private active: number;
  constructor() { super(); this.query = ""; this.active = 0; }
  protected createRenderRoot() { return this; }
  private get matchingActions(): Match[] {
    if (!this.options) return [];
    const query = this.query.trim().replace(/^#/, ""), lower = query.toLowerCase(), matches: Match[] = [];
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
    const actions = gameActions.filter(action => !query || action.key === query || `${action.label} ${action.id}`.toLowerCase().includes(lower));
    actions.sort((a,b) => Number(b.key === query || b.id === lower) - Number(a.key === query || a.id === lower));
    for(const action of actions) matches.push({label:action.label,key:action.key || "#"+action.id,
      action:action.id,reason:this.options.unavailable(action.id),run:()=>this.options.action(action.id)});
    return matches;
  }
  private search(query: string) {
    this.query = query; this.active = 0;
    void this.updateComplete.then(() => {this.querySelector("#more-grid")?.scrollTo(0,0);});
  }
  private key(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
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
    return html`<header><h2 id="menu-title">More actions <kbd>#</kbd></h2>
      <label class="sr-only" for="action-query">Search actions or type a command</label>
      <input id="action-query" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="more-grid" aria-describedby="action-help"
        aria-activedescendant=${matches.length ? `action-match-${this.active}` : nothing}
        .value=${this.query} @input=${(event:InputEvent)=>{if(!event.isComposing)this.search((event.target as HTMLInputElement).value);}}
        @compositionend=${(event:CompositionEvent)=>this.search((event.target as HTMLInputElement).value)} @keydown=${this.key}
        placeholder="Search actions or type 20s, 20., mh…" autocomplete="off" autocapitalize="off" spellcheck="false">
      </header><div id="more-grid" role="listbox" aria-label="Matching actions">${matches.map((match,index)=>html`
        <button type="button" role="option" tabindex="-1" id=${`action-match-${index}`} aria-selected=${index === this.active}
          aria-label=${match.label + (match.reason ? ": " + match.reason : "")} ?disabled=${!!match.reason} data-operation data-unavailable=${match.reason ?? ""}
          data-action=${match.action ?? nothing} @pointermove=${()=>{this.active=index;}} @click=${match.run}>
          <span>${match.label}${match.reason ? html`<small>${match.reason}</small>` : nothing}</span><kbd aria-hidden="true">${match.key}</kbd>
        </button>`)}</div>
      <p id="action-empty" ?hidden=${!!matches.length}>No matching actions.</p>
      <footer><span id="action-count" role="status">${matches.length} match${matches.length===1 ? "" : "es"}</span><span id="action-help">↑ ↓ choose · Enter try · Esc close</span></footer>`;
  }
}
customElements.define("neohack-action-menu", ActionMenu);

export function actionMenu(options: MenuOptions) {
  const element = document.createElement("neohack-action-menu") as ActionMenu;
  element.className = "action-picker"; element.options = options;
  return {element, focus:()=>void element.focusSearch()};
}
