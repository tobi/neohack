import { LitElement, html, css, nothing } from "lit";
import { inspectionData, displayValue, words } from "./inspection.js";
// Pure view: receives an observation, never imports a transport or starts actions.
export class NhInspection extends LitElement {
  static properties = {
    observation: { attribute: false },
    target: { attribute: false },
    recorded: { type: Boolean },
    busy: { type: Boolean },
    decision: { type: Boolean },
    uncertain: { type: Boolean },
  };
  static styles = css`
    :host {
      display: block;
      border: 1px solid var(--line, #2d3a42);
      border-radius: 12px;
      background: var(--panel, #172229);
      color: var(--text, #d8e5df);
      overflow: hidden;
      font:
        13px/1.5 ui-monospace,
        monospace;
    }
    header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line, #2d3a42);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    h2 {
      font-size: 15px;
      margin: 0;
      scroll-margin-top: 12px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    h2:focus-visible {
      outline: 2px solid #96e8be;
      outline-offset: 3px;
    }
    h3 {
      font-size: 12px;
      margin: 18px 0 7px;
      color: #b9d6c9;
    }
    p {
      margin: 8px 0;
    }
    button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--line, #405955);
      border-radius: 6px;
      padding: 5px 9px;
      cursor: pointer;
    }
    button:hover {
      background: #304841;
    }
    button:focus-visible {
      outline: 2px solid #96e8be;
      outline-offset: 2px;
    }
    button[aria-pressed="true"] {
      color: #99e6c3;
      border-color: #65967f;
    }
    nav {
      display: flex;
      gap: 6px;
      padding: 12px 16px 0;
    }
    .body {
      padding: 0 16px 16px;
    }
    .meta {
      font-size: 11px;
      color: #b0c1c1;
    }
    .notice {
      padding: 9px 10px;
      border-left: 2px solid #d5b779;
      background: #2a2b24;
      color: #e9d7b5;
      font-size: 11px;
    }
    dl {
      margin: 12px 0;
    }
    .fact {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
      padding: 5px 0;
      border-bottom: 1px solid #ffffff08;
    }
    dt {
      color: #9fb3b6;
    }
    dd {
      margin: 0;
      text-align: right;
      overflow-wrap: anywhere;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li {
      padding: 7px 0;
      border-bottom: 1px solid #ffffff0c;
      overflow-wrap: anywhere;
    }
    .tag {
      display: inline-block;
      padding: 1px 6px;
      border: 1px solid #506862;
      border-radius: 5px;
      margin: 0 5px 3px 0;
      font-size: 10px;
      color: #b6dfc8;
    }
    .item-meta {
      color: #a1b8b8;
      font-size: 10px;
    }
    details summary {
      cursor: pointer;
      color: #a8c6b9;
      padding-top: 10px;
    }
    .scroll {
      max-height: 320px;
      overflow: auto;
    }
  `;
  constructor() {
    super();
    this.observation = null;
    this.target = "self";
    this.recorded = false;
    this.busy = false;
    this.decision = false;
    this.uncertain = false;
    this.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }
  focusHeading() {
    const heading = this.renderRoot.querySelector("h2");
    heading?.focus({ preventScroll: true });
    const rect = heading?.getBoundingClientRect();
    if (rect && (rect.top < 0 || rect.bottom > innerHeight))
      heading.scrollIntoView({ block: "start", behavior: "instant" });
  }
  close() {
    this.dispatchEvent(
      new CustomEvent("inspection-close", { bubbles: true, composed: true }),
    );
  }
  choose(target) {
    this.dispatchEvent(
      new CustomEvent("inspect-target", {
        detail: target,
        bubbles: true,
        composed: true,
      }),
    );
  }
  facts(rows) {
    return html`<dl>
      ${rows.map(
        ([key, value]) =>
          html`<div class="fact">
            <dt>${key}</dt>
            <dd>${value}</dd>
          </div>`,
      )}
    </dl>`;
  }
  items(items, equipment = false) {
    return html`<ul class="scroll">
      ${items.map(
        (i) =>
          html`<li>
            <span>${displayValue(i.label)}</span>
            <div class="item-meta">
              ${displayValue(i.quantity)} × ·
              ${words(i.category) || "category not reported"}${equipment
                ? html` · ${i.usage.map(words).join(", ")}`
                : nothing}
            </div>
          </li>`,
      )}
    </ul>`;
  }
  render() {
    const d = inspectionData(this.observation, this.target);
    return html`<header>
        <h2 tabindex="-1">${d.title}</h2>
        <button aria-label="Close inspection" @click=${() => this.close()}>
          ×
        </button>
      </header>
      <nav aria-label="Inspection target">
        <button
          aria-pressed=${this.target === "self"}
          @click=${() => this.choose("self")}
        >
          Self</button
        ><button
          aria-pressed=${this.target === "here"}
          @click=${() => this.choose("here")}
        >
          Here
        </button>
      </nav>
      <div class="body">
        <p class="meta">
          ${this.recorded ? "Recorded observation" : "Reported observation"} ·
          Turn ${displayValue(this.observation?.turn)} · ${d.context ?? ""}
        </p>
        ${this.busy || this.decision || this.uncertain
          ? html`<p class="notice">
              ${this.uncertain
                ? "World state needs recovery."
                : this.busy
                  ? "An action is in progress."
                  : "A decision is still waiting."}
              Inspection reads the reported observation and submits no answer.
            </p>`
          : nothing}
        ${d.notice ? html`<p class="notice">${d.notice}</p>` : nothing}
        ${this.facts(d.kind === "self" ? d.rows.slice(0, 6) : d.rows)}
        ${d.kind === "self"
          ? html`
              <h3>Reported conditions</h3>
              ${d.conditions === null
                ? html`<p class="notice">Conditions were not captured.</p>`
                : d.conditions.length
                  ? html`<p>
                      ${d.conditions.map(
                        (c) => html`<span class="tag">${words(c)}</span>`,
                      )}
                    </p>`
                  : html`<p class="meta">No conditions reported.</p>`}
              <h3>Equipment assignments</h3>
              <p class=${d.equipmentState === "lastKnown" ? "notice" : "meta"}>
                ${d.equipmentFreshness}
              </p>
              ${!d.equipmentKnown
                ? html`<p class="notice">
                    Equipment use was not captured. Labels below are preserved,
                    but are not parsed into equipment facts.
                  </p>`
                : d.equipment.length
                  ? this.items(d.equipment, true)
                  : html`<p class="meta">
                      No equipment assignments reported.
                    </p>`}
              <details>
                <summary>Attributes and notices</summary>
                ${this.facts(d.rows.slice(6))}
              </details>
              <details>
                <summary>Reported belongings (${d.inventory.length})</summary>
                <p
                  class=${d.inventoryState === "lastKnown" ? "notice" : "meta"}
                >
                  ${d.inventoryFreshness}
                </p>
                ${d.inventoryKnown
                  ? this.items(d.inventory)
                  : html`<p class="notice">
                      Inventory was not captured; the pack is not assumed empty.
                    </p>`}
              </details>
            `
          : d.kind === "here" || d.kind === "tile"
            ? html`
                <h3>${d.here ? "Floor items" : "Map object sightings"}</h3>
                <p
                  class=${d.freshnessState === "lastKnown" ? "notice" : "meta"}
                >
                  ${d.freshness}
                </p>
                ${d.here
                  ? d.known
                    ? d.items.length
                      ? this.items(d.items)
                      : html`<p class="meta">No floor items reported.</p>`
                    : nothing
                  : d.sightings.length
                    ? html`<ul>
                        ${d.sightings.map(
                          (i) =>
                            html`<li>
                              ${typeof i.label === "string"
                                ? i.label
                                : html`Object glyph
                                    <code>${i.mark ?? "?"}</code>`}
                            </li>`,
                        )}
                      </ul>`
                    : html`<p class="meta">No object glyph reported.</p>`}
              `
            : nothing}
        <p class="meta">
          Perceived information only. No hidden properties, nearby contents, or
          earlier-frame facts are inferred.
        </p>
      </div>`;
  }
}
if (!customElements.get("nh-inspection"))
  customElements.define("nh-inspection", NhInspection);
