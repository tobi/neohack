import type { LoreResponse } from 'neonethack/types';

/** Pinned engine lore, kept separate from the hero's perceived scene. */
export function encyclopedia(game: {lookup(name: string): Promise<LoreResponse>}) {
  const element = document.createElement('section');
  element.className = 'encyclopedia';
  element.innerHTML = `<h2 id="menu-title">Encyclopedia</h2>
    <p class="subtle">NetHack’s book of creatures, objects and places. Reading costs no turns.</p>
    <form class="lore-search"><label for="lore-query">Look up a name</label><div><input id="lore-query" name="query" maxlength="255" required autocomplete="off" placeholder="A creature, item or place"><button class="primary" type="submit">Look up</button></div></form>
    <p class="lore-status subtle" role="status"></p>
    <article class="lore-entry" aria-label="Encyclopedia entry" tabindex="0" hidden><h3></h3><div class="lore-copy"></div><p class="subtle">From NetHack’s encyclopedia. Lore does not identify what you have encountered.</p></article>`;
  const form = element.querySelector<HTMLFormElement>('form')!;
  const input = element.querySelector<HTMLInputElement>('input')!;
  const button = element.querySelector<HTMLButtonElement>('button')!;
  const status = element.querySelector<HTMLElement>('.lore-status')!;
  const entry = element.querySelector<HTMLElement>('.lore-entry')!;
  form.onsubmit = async event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || button.disabled) return;
    button.disabled = true; status.textContent = 'Opening the book…'; entry.hidden = true;
    try {
      const result = await game.lookup(name);
      if (!element.isConnected) return;
      if (!result.found) { status.textContent = `No entry for “${name}”. Try another name.`; return; }
      entry.querySelector('h3')!.textContent = name;
      const copy=entry.querySelector('.lore-copy')!;
      copy.replaceChildren(...result.lines.join('\n').split(/\n\s*\n/).filter(text=>text.trim()).map(text=>{
        const paragraph=document.createElement('p');
        paragraph.textContent=text.replace(/\s*\n\s*/g,' ').trim();
        return paragraph;
      }));
      entry.hidden = false; status.textContent = 'Entry found.';
      entry.focus({preventScroll:true});
    } catch (error) {
      if (element.isConnected) status.textContent = error instanceof Error ? error.message : 'The book could not be opened.';
    } finally { button.disabled = false; }
  };
  return element;
}
