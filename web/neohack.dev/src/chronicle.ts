/** A dungeon chronicle: the server's cached AI retelling of a concluded run.
 * This module only reads and requests that artifact and renders it; the story
 * is generated once per run on the server and never regenerated on a view. */
export type ChronicleSegment = { text: string; term?: string };
export type ChronicleDocument = {
  available: true;
  model: string;
  promptVersion: string;
  generatedAt: number;
  hero: { name?: string; role?: string; race?: string };
  coverage: { observedReplies?: number; selectedEvents?: number; complete?: boolean };
  story: { title: string; paragraphs: { text: string; sources: string[]; segments?: ChronicleSegment[] }[] };
  glossary: Record<string, { name: string; lines: string[] }>;
};
export type ChronicleRun = { ended?: boolean; endKind?: string; maxDepth?: number; maxLevel?: number };

/** Mirrors hosting/vercel/src/chronicle.ts; the server remains the authority. */
export const CHRONICLE_MIN_DEPTH = 3;
export const CHRONICLE_MIN_LEVEL = 2;
export function chronicleEligible(run: ChronicleRun | null | undefined) {
  return !!run && run.ended === true && run.endKind === "death" &&
    (run.maxDepth ?? 0) >= CHRONICLE_MIN_DEPTH && (run.maxLevel ?? 0) >= CHRONICLE_MIN_LEVEL;
}
export const chronicleLink = (id: string) =>
  new URL("/dashboard?run=" + encodeURIComponent(id) + "&view=chronicle", location.origin).href;

const endpoint = (id: string) => new URL("/api/runs/" + encodeURIComponent(id) + "/chronicle", location.origin);

/** The cached chronicle, or null when none has been written yet. */
export async function fetchChronicle(id: string, signal?: AbortSignal): Promise<ChronicleDocument | null> {
  const response = await fetch(endpoint(id), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw Error("The chronicle could not be read right now.");
  const doc = await response.json();
  return doc?.available === true && doc.story ? (doc as ChronicleDocument) : null;
}

/** Ask the chronicler to write (or return) this run's tale. Resolves with the
 * story; rejects with a readable reason. A pending tale is polled briefly. */
export async function requestChronicle(id: string, options: { signal?: AbortSignal; onStatus?: (text: string) => void } = {}): Promise<ChronicleDocument> {
  options.onStatus?.("The chronicler is reading the journal… this takes about half a minute.");
  const response = await fetch(endpoint(id), { method: "POST", signal: options.signal });
  const body = await response.json().catch(() => ({}));
  if (response.ok && body?.available === true) return body as ChronicleDocument;
  if (response.status === 202) {
    options.onStatus?.("Another visitor asked first; waiting for the same tale…");
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 4000));
      options.signal?.throwIfAborted();
      const doc = await fetchChronicle(id, options.signal);
      if (doc) return doc;
    }
    throw Error("The chronicler is still writing. Try again in a moment.");
  }
  throw Error(typeof body?.error === "string" ? body.error : "The chronicler could not finish this tale.");
}

export function chronicleIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3h11a2 2 0 0 1 2 2v13a3 3 0 0 1-3 3H5a2 2 0 0 1-2-2v-1h12v1a1 1 0 0 0 2 0V5H7v2H4V5a2 2 0 0 1 2-2Zm4 6h6m-6 4h6m-6 4h3"/></svg>';
}

/** Render the story with dotted encyclopedia names; a tap opens the entry inline. */
export function chronicleView(doc: ChronicleDocument, options: { replayHref?: string; heading?: "h2" | "h3" } = {}) {
  const article = document.createElement("article");
  article.className = "chronicle";
  const title = document.createElement(options.heading ?? "h2");
  title.className = "chronicle-title";
  title.id = "chronicle-title";
  title.textContent = doc.story.title;
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow chronicle-eyebrow";
  eyebrow.textContent = "A DUNGEON CHRONICLE" + (doc.hero?.name ? " · " + doc.hero.name.toUpperCase() : "");
  article.append(eyebrow, title);
  const lore = document.createElement("aside");
  lore.className = "chronicle-lore";
  lore.hidden = true;
  lore.setAttribute("aria-live", "polite");
  let active: HTMLButtonElement | null = null;
  const openLore = (term: string, button: HTMLButtonElement) => {
    const entry = doc.glossary?.[term];
    if (!entry) return;
    active?.setAttribute("aria-expanded", "false");
    active = button;
    button.setAttribute("aria-expanded", "true");
    lore.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = entry.name;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "text-button chronicle-lore-close";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close encyclopedia entry");
    close.onclick = () => { lore.hidden = true; active?.setAttribute("aria-expanded", "false"); active?.focus(); active = null; };
    const top = document.createElement("div");
    top.className = "chronicle-lore-top";
    top.append(heading, close);
    lore.append(top, ...entry.lines.join("\n").split(/\n\s*\n/).filter((t) => t.trim()).map((t) => {
      const p = document.createElement("p");
      p.textContent = t.replace(/\s*\n\s*/g, " ").trim();
      return p;
    }));
    const note = document.createElement("p");
    note.className = "subtle";
    note.textContent = "From the engine’s encyclopedia. Lore is reference text, not the identity of what the hero met.";
    lore.append(note);
    lore.hidden = false;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  };
  for (const paragraph of doc.story.paragraphs) {
    const p = document.createElement("p");
    p.className = "chronicle-paragraph";
    for (const segment of paragraph.segments ?? [{ text: paragraph.text }]) {
      if (segment.term && doc.glossary?.[segment.term]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lore-link chronicle-term";
        button.textContent = segment.text;
        button.title = "Encyclopedia: " + segment.term;
        button.setAttribute("aria-label", segment.text + " — look up " + segment.term + " in the encyclopedia");
        button.setAttribute("aria-expanded", "false");
        button.onclick = () => openLore(segment.term!, button);
        p.append(button);
      } else p.append(document.createTextNode(segment.text));
    }
    article.append(p);
  }
  article.append(lore);
  const footer = document.createElement("footer");
  footer.className = "chronicle-footer subtle";
  const about = document.createElement("p");
  about.textContent = `An AI retelling (${doc.model}) of the recorded journey, written once from ${doc.coverage?.selectedEvents ?? "the"} witnessed moments${doc.coverage?.complete === false ? "; the recording is incomplete" : ""}. It is a story, not the journal.`;
  footer.append(about);
  if (options.replayHref) {
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = options.replayHref;
    a.textContent = "Watch the replay ↗";
    a.target = "_blank";
    a.rel = "noopener";
    p.append(a);
    footer.append(p);
  }
  article.append(footer);
  return article;
}
