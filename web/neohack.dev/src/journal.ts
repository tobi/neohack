import type { Snapshot } from "neonethack/types";
export interface JournalEntry {
  turn: number;
  lastTurn: number;
  text: string;
  count: number;
  passage?: boolean;
}
export function journalScroll(entry: Pick<JournalEntry, "text" | "passage">) {
  return (
    entry.passage === true &&
    entry.text.split("\n").filter((line) => line.trim()).length >= 4
  );
}
/** Engine text windows are passages; routine messages never acquire that meaning by length. */
export function appendReceipt(
  entries: JournalEntry[],
  snapshot: Snapshot,
  fallback: string[] = [],
) {
  let routine: string[] = [];
  const append = (text: string, passage = false) => {
    if (!text.trim()) return;
    const previous = entries.at(-1);
    if (previous?.text === text && !!previous.passage === passage) {
      previous.count++;
      previous.lastTurn = snapshot.observation.turn;
    } else
      entries.push({
        turn: snapshot.observation.turn,
        lastTurn: snapshot.observation.turn,
        text,
        count: 1,
        passage,
      });
  };
  const flush = () => {
    append(routine.join("\n"));
    routine = [];
  };
  for (const event of snapshot.events) {
    if (event.type === "heard" && !event.textWindow) routine.push(event.text);
    if (event.type === "passage") {
      flush();
      append(event.text, true);
    }
  }
  flush();
  if (
    !snapshot.events.some(
      (event) => event.type === "heard" || event.type === "passage",
    )
  )
    append(fallback.join("\n"));
}
export function renderJournalEntry(
  host: HTMLElement,
  entry: JournalEntry,
  open: (entry: JournalEntry) => void,
) {
  if (!journalScroll(entry)) {
    const copy = document.createElement("span");
    copy.className = "journal-inline";
    copy.textContent = entry.text.trim();
    host.append(copy);
    if (entry.count > 1) {
      const count = document.createElement("small");
      count.className = "journal-repeat";
      count.setAttribute("aria-label", "Repeated " + entry.count + " times");
      count.textContent = "×" + entry.count;
      host.append(count);
    }
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "journal-scroll-link";
  const mark = document.createElement("span");
  mark.className = "scroll-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "▤";
  const copy = document.createElement("span"),
    title = document.createElement("strong"),
    excerpt = document.createElement("span");
  title.textContent = "Read journal scroll";
  excerpt.className = "scroll-excerpt";
  excerpt.textContent = entry.text.trim().split("\n")[0]!;
  copy.append(title, excerpt);
  button.append(mark, copy);
  button.setAttribute("aria-label", "Read journal scroll · turn " + entry.turn);
  button.onclick = () => open(entry);
  host.append(button);
}
