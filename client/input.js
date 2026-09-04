// Intent capture: while the world waits on a deed, keyboard and map
// clicks become moves. Nothing engine-shaped crosses this file: arrows
// and vi-keys map to move names, clicks to tiles (the page resolves the
// step from where you stand). Armed only while awaiting "act".
const MOVES = {
  ArrowUp: "n", ArrowDown: "s", ArrowLeft: "w", ArrowRight: "e",
  k: "n", j: "s", h: "w", l: "e",
  y: "nw", u: "ne", b: "sw", n: "se",
  ".": "wait", ">": "down", "<": "up",
};

export function createInput({ canvas, onMove, onStep, onKey }) {
  const state = { armed: false, screenToTile: null };

  function handleKey(ev) {
    if (!state.armed) return;
    const move = MOVES[ev.key] ?? null;
    if (move != null) {
      ev.preventDefault();
      onMove(move);
      return;
    }
    // Any other single letter is a deed with no named intent yet (the
    // world answers with what it waits on: usually a choice or words).
    if (typeof ev.key === "string" && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      onKey(ev.key);
    }
  }

  function handleClick(ev) {
    if (!state.armed || !state.screenToTile || !canvas) return;
    // Shift/right-clicks are camera pans (see map3d), not moves.
    if (ev.shiftKey || (ev.button !== undefined && ev.button !== 0)) return;
    const tile = state.screenToTile(ev.clientX, ev.clientY);
    if (tile) onStep(tile);
  }

  if (canvas) {
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", handleKey);
    canvas.addEventListener("click", handleClick);
  } else {
    window.addEventListener("keydown", handleKey);
  }

  return {
    setArmed(on) { state.armed = !!on; },
    setScreenToTile(fn) { state.screenToTile = fn; },
  };
}
