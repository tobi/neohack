import { LitElement, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { journalScroll, type JournalEntry } from "./journal";

/** Bounded presentation only: the owning game retains the complete journal. */
export class JournalPreview extends LitElement {
  static properties = { entries: {state:true} };
  declare private entries: {entry: JournalEntry; count: number; fresh: boolean}[];
  constructor() {
    super(); this.entries = [];
    this.addEventListener("click", event=>{if(event.target===this)this.open();});
  }
  private session = "";
  protected createRenderRoot() { return this; }
  show(journal: JournalEntry[], session: string) {
    const recent = journal.slice(-8).reverse();
    if (session === this.session && recent.length === this.entries.length &&
        recent.every((entry,i)=>entry===this.entries[i]?.entry && entry.count===this.entries[i]?.count)) return;
    const previous = new Map(this.entries.map(row=>[row.entry,row]));
    this.entries = recent.map(entry=>previous.get(entry)?.count===entry.count ? previous.get(entry)! : ({entry, count:entry.count,
      fresh:session===this.session}));
    this.session = session;
  }
  private open() { this.dispatchEvent(new CustomEvent("open-journal", {bubbles:true})); }
  protected render() {
    return html`${repeat(this.entries, row=>row, ({entry,count,fresh})=>html`
      <p class=${fresh ? "journal-arrival" : ""}><button type="button" class="journal-preview-entry" @click=${this.open}
        title="Open journal"><span class="journal-inline">${journalScroll(entry) ? "▤ " : ""}${entry.text.trim()}</span>${count>1 ? html`<small class="journal-repeat" aria-label=${`Repeated ${count} times`}>×${count}</small>` : ""}</button></p>`)}
      ${this.entries.length ? "" : html`<button class="journal-preview-entry" @click=${this.open}>Open journal</button>`}`;
  }
}
customElements.define("neohack-journal-preview", JournalPreview);
