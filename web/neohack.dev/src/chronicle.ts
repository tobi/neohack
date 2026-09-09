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
/** The story's home is the run's own page, which leads with the chronicle. */
export const chronicleLink = (id: string) =>
  new URL("/replays/" + encodeURIComponent(id) + "?view=chronicle", location.origin).href;

const endpoint = (id: string) => new URL("/api/runs/" + encodeURIComponent(id) + "/chronicle", location.origin);

/** The cached chronicle, or null when none has been written yet. */
export async function fetchChronicle(id: string, signal?: AbortSignal): Promise<ChronicleDocument | null> {
  const response = await fetch(endpoint(id), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw Error("The chronicle could not be read right now.");
  const doc = await response.json();
  return doc?.available === true && doc.story ? (doc as ChronicleDocument) : null;
}

/** The story so far, read from the model's markdown as it streams in: the
 * heading becomes the title; trailing [T12, T40] citations are hidden. */
export type ChronicleDraft = { title: string; paragraphs: string[]; complete: boolean };
export function draftFromMarkdown(text: string, complete = false): ChronicleDraft {
  const lines = text.replace(/\r/g, "").replace(/^```(?:markdown|md)?\s*/, "").split("\n");
  while (lines.length && !lines[0]?.trim()) lines.shift();
  const heading = lines.shift() ?? "";
  const title = heading.replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "").trim();
  const paragraphs = lines.join("\n").split(/\n\s*\n/).map((p) =>
    p.replace(/\s*\n\s*/g, " ").replace(/\s*\[[^\[\]]*$/, "").replace(/\[[^\[\]]*\bT\d+[^\[\]]*\]/g, "").replace(/\s{2,}/g, " ").trim(),
  ).filter(Boolean);
  return { title, paragraphs, complete };
}

export type ChronicleProgress = { onStatus?: (text: string) => void; onDraft?: (draft: ChronicleDraft) => void };
const fmt = (n: number) => n.toLocaleString("en-US");

/** Ask the chronicler to write (or return) this run's tale. Resolves with the
 * stored story; rejects with a readable reason. While the server works, the
 * stream reports replay progress and the story text as it is written. The
 * server finishes and stores the tale whether or not this reader stays. */
export async function requestChronicle(id: string, options: { signal?: AbortSignal } & ChronicleProgress = {}): Promise<ChronicleDocument> {
  options.onStatus?.("The chronicler is opening the journal…");
  const response = await fetch(endpoint(id), { method: "POST", signal: options.signal, headers: { accept: "application/x-ndjson" } });
  if ((response.headers.get("content-type") ?? "").includes("application/x-ndjson") && response.body) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", text = "";
    const handle = (line: string): ChronicleDocument | undefined => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (typeof event.delta === "string") {
        text += event.delta;
        options.onDraft?.(draftFromMarkdown(text));
        options.onStatus?.("The chronicler is writing…");
      } else if (event.status === "replaying")
        options.onStatus?.(event.total > 0 ? `Reading the journal… ${fmt(Math.min(event.done, event.total))} of ${fmt(event.total)} moves.` : "Reading the journal…");
      else if (event.status === "writing") options.onStatus?.("The chronicler is writing…");
      else if (event.status === "storing") options.onStatus?.("Keeping the tale with the replay…");
      else if (event.available === true && event.story) return event as ChronicleDocument;
      else if (event.available === false) throw Error(typeof event.error === "string" ? event.error : "The chronicler could not finish this tale.");
      return;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const doc = handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (doc) return doc;
      }
    }
    const doc = handle(buffer);
    if (doc) return doc;
    throw Error("The chronicler's connection ended early; the tale is still being kept and will appear in the ledger.");
  }
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

/** A live page for the tale as it is written; `update` redraws the draft and
 * the caller swaps in chronicleView(doc) once the stored story arrives. */
export function chronicleDraftView(hero?: string, heading: "h2" | "h3" = "h2") {
  const article = document.createElement("article");
  article.className = "chronicle chronicle-draft";
  article.setAttribute("aria-busy", "true");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow chronicle-eyebrow";
  eyebrow.textContent = "A DUNGEON CHRONICLE" + (hero ? " · " + hero.toUpperCase() : "");
  const title = document.createElement(heading);
  title.className = "chronicle-title";
  title.textContent = "…";
  const body = document.createElement("div");
  body.className = "chronicle-draft-body";
  const progress = document.createElement("p");
  progress.className = "chronicle-progress subtle";
  progress.setAttribute("role", "status");
  article.append(eyebrow, title, body, progress);
  return {
    element: article,
    status(text: string) { progress.textContent = text; },
    update(draft: ChronicleDraft) {
      if (draft.title) title.textContent = draft.title;
      const existing = body.querySelectorAll<HTMLParagraphElement>("p");
      draft.paragraphs.forEach((text, i) => {
        const p = existing[i] ?? body.appendChild(document.createElement("p"));
        p.className = "chronicle-paragraph" + (i === draft.paragraphs.length - 1 && !draft.complete ? " chronicle-writing" : "");
        if (p.textContent !== text) p.textContent = text;
      });
      for (let i = draft.paragraphs.length; i < existing.length; i++) existing[i]?.remove();
    },
  };
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
  // Encyclopedia entries open in a small popover anchored to the tapped name,
  // inside the article so it scrolls with the text.
  const lore = document.createElement("div");
  lore.className = "chronicle-lore";
  lore.hidden = true;
  lore.setAttribute("role", "dialog");
  lore.setAttribute("aria-modal", "false");
  let active: HTMLButtonElement | null = null;
  const closeLore = (refocus = false) => {
    if (lore.hidden) return;
    lore.hidden = true;
    active?.setAttribute("aria-expanded", "false");
    if (refocus) active?.focus();
    active = null;
  };
  const place = (button: HTMLButtonElement) => {
    const a = article.getBoundingClientRect(), b = button.getBoundingClientRect();
    const width = Math.min(360, a.width);
    lore.style.width = width + "px";
    const anchorX = b.left - a.left + b.width / 2;
    const left = Math.max(0, Math.min(anchorX - width / 2, a.width - width));
    lore.style.left = left + "px";
    lore.style.setProperty("--caret-x", Math.max(14, Math.min(anchorX - left, width - 14)) + "px");
    // Below the name when it fits in the visible part of the scroll parent, otherwise above.
    let scroller: HTMLElement | null = article.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const viewBottom = Math.min(window.innerHeight, scroller ? scroller.getBoundingClientRect().bottom : Infinity);
    const viewTop = Math.max(0, scroller ? scroller.getBoundingClientRect().top : 0);
    const height = lore.offsetHeight;
    const below = b.bottom + 10 + height <= viewBottom || b.top - 10 - height < viewTop;
    lore.classList.toggle("above", !below);
    lore.style.top = (below ? b.bottom - a.top + 10 : b.top - a.top - height - 10) + "px";
  };
  const openLore = (term: string, button: HTMLButtonElement) => {
    const entry = doc.glossary?.[term];
    if (!entry) return;
    if (active === button) return closeLore(true);
    active?.setAttribute("aria-expanded", "false");
    active = button;
    button.setAttribute("aria-expanded", "true");
    lore.replaceChildren();
    lore.setAttribute("aria-label", "Encyclopedia: " + entry.name);
    const heading = document.createElement("h3");
    heading.textContent = entry.name;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "text-button chronicle-lore-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close encyclopedia entry");
    close.onclick = () => closeLore(true);
    const top = document.createElement("div");
    top.className = "chronicle-lore-top";
    top.append(heading, close);
    const texts = entry.lines.join("\n").split(/\n\s*\n/).filter((t) => t.trim()).map((t) => t.replace(/\s*\n\s*/g, " ").trim());
    const body = document.createElement("div");
    body.className = "chronicle-lore-body";
    const paragraphs = texts.map((t) => {
      const p = document.createElement("p");
      p.textContent = t;
      return p;
    });
    body.append(...paragraphs.slice(0, 2));
    lore.append(top, body);
    if (paragraphs.length > 2) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "text-button chronicle-lore-more";
      more.textContent = "Read the whole entry";
      more.onclick = () => {
        body.append(...paragraphs.slice(2));
        more.remove();
        place(button);
      };
      lore.append(more);
    }
    const note = document.createElement("p");
    note.className = "subtle chronicle-lore-note";
    note.textContent = "From the engine’s encyclopedia; reference text, not the identity of what the hero met.";
    lore.append(note);
    lore.hidden = false;
    place(button);
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  };
  article.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !lore.hidden) {
      event.stopPropagation();
      event.preventDefault();
      closeLore(true);
    }
  });
  article.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!lore.hidden && !lore.contains(target) && !(active && active.contains(target))) closeLore();
  });
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
