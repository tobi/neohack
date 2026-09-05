import { createWasm } from 'neonethack/wasm';
import type { Neonethack, Game, Snapshot, Compass } from 'neonethack';

const directions: Compass[] = ['northwest', 'north', 'northeast', 'west', 'east', 'southwest', 'south', 'southeast'];
const terrain: Record<string, string> = { wall: '#', floor: '.', corridor: '·', closedDoor: '+', openDoor: '/', stairsUp: '<', stairsDown: '>', altar: '_', fountain: '{', water: '≈', lava: '≈', trap: '^', dark: ' ', unknown: ' ' };

class NeonethackExample extends HTMLElement {
  private api: Neonethack | null = null;
  private game: Game | null = null;
  private busy = false;
  private root = this.attachShadow({ mode: 'open' });
  private lastId = localStorage.getItem('neonethack-example-session');
  private status = document.createElement('p');
  private controls = document.createElement('section');
  private map = document.createElement('pre');
  private choices = document.createElement('section');
  private journal = document.createElement('pre');
  private frame = document.createElement('pre');
  private error = document.createElement('p');

  connectedCallback() {
    this.root.innerHTML = `<style>
      :host { display:block; } button,input { font:inherit; padding:.4rem .65rem; }
      button { cursor:pointer; } button:disabled { cursor:default; }
      section { display:flex; flex-wrap:wrap; gap:.4rem; margin:1rem 0; align-items:center; }
      pre { background:#181e27; padding:1rem; border-radius:.5rem; overflow:auto; }
      #map { line-height:1.12; font-size:clamp(10px,1.4vw,17px); min-height:12rem; }
      #journal { white-space:pre-wrap; } #error { color:#ffb3a6; } label { display:inline-flex; gap:.5rem; }
      details pre { max-height:30rem; font-size:12px; } h2 { font-size:1.1rem; }
    </style>`;
    this.map.id = 'map'; this.map.setAttribute('aria-label', 'Perceived dungeon');
    this.journal.id = 'journal'; this.journal.setAttribute('aria-live', 'polite');
    this.error.id = 'error'; this.error.setAttribute('role', 'alert');
    this.frame.id = 'frame';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Full public response';
    details.append(summary, this.frame);
    this.root.append(this.status, this.controls, this.error, this.map, this.choices, this.journal, details);
    void this.run(async () => {
      this.api = await createWasm({ storage: { kind: 'indexeddb', name: 'example' } });
      const info = await this.api.describe();
      this.status.textContent = `Ready · ${info.capabilities.persistence} · one owner per browser store. Closing a world retains it; clearing site data deletes local history.`;
    });
  }
  private button(parent: HTMLElement, label: string, action: () => Promise<unknown>, enabled = true) {
    const button = document.createElement('button'); button.textContent = label;
    button.disabled = this.busy || !enabled;
    button.addEventListener('click', () => { void this.run(action); });
    parent.append(button);
  }
  private async run(action: () => Promise<unknown>) {
    if (this.busy) return;
    this.busy = true; this.error.textContent = ''; this.renderControls();
    try {
      const response = await action();
      if (response && typeof response === 'object' && 'observation' in response) this.show(response as Snapshot);
    } catch (error) {
      this.error.textContent = error instanceof Error ? error.message : String(error);
      if (this.game) this.show(this.game.state);
    } finally { this.busy = false; this.renderControls(); }
  }
  private renderControls() {
    this.controls.replaceChildren(); this.choices.replaceChildren();
    this.button(this.controls, 'New world', async () => {
      if (this.game) await this.game.close();
      this.game = await this.api!.create({ name: 'Explorer', seed: 42, role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
      this.lastId = this.game.id; localStorage.setItem('neonethack-example-session', this.game.id);
      return this.game.state;
    }, !!this.api);
    this.button(this.controls, 'Resume', async () => {
      this.game = await this.api!.resume(this.lastId!); return this.game.state;
    }, !!this.api && !!this.lastId && !this.game);
    this.button(this.controls, 'Retire', async () => {
      const result = await this.game!.close(); this.game = null; return result;
    }, !!this.game);
    if (!this.game) return;
    const ready = !this.game.decision && !this.game.state.ended && !this.game.pendingRequest;
    for (const direction of directions) this.button(this.controls, direction, () => this.game!.move(direction), ready);
    this.button(this.controls, 'Wait', () => this.game!.wait(), ready);
    this.button(this.controls, 'Search', () => this.game!.search(), ready);
    this.button(this.controls, 'Eat', () => this.game!.eat(), ready);
    this.button(this.controls, 'Pick up', () => this.game!.pickup(), ready);
    this.button(this.controls, 'Pray', () => this.game!.pray(), ready);
    this.button(this.controls, 'Observe', () => this.game!.observe());
    if (this.game.pendingRequest) this.button(this.controls, 'Retrieve same receipt', () => this.game!.retry());
    const decision = this.game.decision;
    if (!decision) return;
    const heading = document.createElement('h2'); heading.textContent = decision.about ?? `Choose: ${decision.kind}`;
    this.choices.append(heading);
    if (decision.kind === 'confirmation') {
      for (const confirm of [true, false]) this.button(this.choices, confirm ? 'Yes' : 'No', () => this.game!.answer(decision.id, { kind: 'confirmation', confirm }));
    } else if (decision.kind === 'item') {
      for (const item of decision.options) this.button(this.choices, item.label, () => this.game!.answer(decision.id, { kind: 'item', item: { id: item.id } }));
    } else if (decision.kind === 'target') {
      if (decision.allowedTargets.includes('self')) this.button(this.choices, 'Self', () => this.game!.answer(decision.id, { kind: 'target', target: 'self' }));
      for (const direction of directions) this.button(this.choices, direction, () => this.game!.answer(decision.id, { kind: 'target', target: { direction } }));
    } else if (decision.kind === 'choice') {
      const inputs = decision.options.map(option => {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = (decision.selection?.max ?? 1) > 1 ? 'checkbox' : 'radio'; input.name = 'choice';
        label.append(input, document.createTextNode(option.label)); this.choices.append(label);
        return { input, id: option.id };
      });
      this.button(this.choices, 'Choose', () => this.game!.answer(decision.id, { kind: 'choice', choose: inputs.filter(v => v.input.checked).map(v => v.id) }));
    } else if (decision.kind === 'text') {
      const label = document.createElement('label'), input = document.createElement('input');
      label.append(document.createTextNode('Your answer'), input); this.choices.append(label);
      this.button(this.choices, 'Answer', () => this.game!.answer(decision.id, { kind: 'text', text: input.value }));
    }
    if (decision.cancellable) this.button(this.choices, 'Cancel choice', () => this.game!.cancel(decision.id));
  }
  private show(response: Snapshot) {
    const o = response.observation;
    this.status.textContent = `${response.sessionId} · Turn ${o.turn} · HP ${o.vitals.health ?? '?'}/${o.vitals.maxHealth ?? '?'} · ${o.location.depthLabel}${response.ended ? ` · ${response.end?.kind}` : ''}`;
    const rows = Array.from({ length: 21 }, () => Array<string>(80).fill(' '));
    for (const cell of o.world) if (rows[cell.y] && cell.x >= 0 && cell.x < 80) {
      rows[cell.y]![cell.x] = cell.occupant?.kind === 'self' ? '@' : cell.occupant?.mark ?? cell.objects?.[0]?.mark ?? terrain[cell.terrain.type] ?? '?';
    }
    this.map.textContent = rows.map(row => row.join('')).join('\n');
    this.journal.textContent = o.heard.join('\n');
    this.frame.textContent = JSON.stringify(response, null, 2);
  }
}
customElements.define('neonethack-example', NeonethackExample);
