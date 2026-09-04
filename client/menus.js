// menus.js — modal menu / yn / getline / text windows as clickable DOM.
// No game rules: renders server-supplied items and resolves with the ids
// the user picked. Keyboard accelerators AND mouse clicks both work.
// Only one dialog is shown at a time; extras queue (matches net.js input
// discipline where the server sends one input request at a time).

export function createMenus(overlay) {
  const queue = [];
  let open = false;
  let currentDone = null;

  // spec: {kind: 'menu'|'yn'|'line'|'text', title, prompt, items, choices,
  //        initial, multi}
  // resolve(resultPayload) / dismiss(cancelled:boolean)
  function show(spec) {
    return new Promise((resolve) => {
      queue.push({ spec, resolve });
      pump();
    });
  }

  // Dismiss the open dialog (if any) as cancelled, e.g. on ESC typed
  // outside the dialog while an input request is pending.
  function close() {
    if (open && currentDone) {
      const done = currentDone;
      currentDone = null;
      done({ cancelled: true });
    }
  }

  function pump() {
    if (open || !queue.length) return;
    open = true;
    const { spec, resolve } = queue.shift();
    render(spec, (result) => {
      open = false;
      currentDone = null;
      overlay.innerHTML = "";
      overlay.classList.remove("open");
      resolve(result);
      pump();
    });
  }

  function render(spec, done) {
    currentDone = done;
    overlay.classList.add("open");
    const box = document.createElement("div");
    box.className = "dlg";
    const h = document.createElement("h2");
    h.textContent = spec.title || spec.prompt || "NetHack";
    box.appendChild(h);

    if (spec.kind === "text") {
      const pre = document.createElement("pre");
      pre.textContent = (spec.lines || []).join("\n");
      box.appendChild(pre);
      box.appendChild(buttonRow([["OK", () => done({ dismissed: true })]]));
    } else if (spec.kind === "yn") {
      const p = document.createElement("p");
      p.textContent = spec.prompt || "";
      box.appendChild(p);
      const choices = spec.choices || ["y", "n"];
      box.appendChild(buttonRow(choices.map((c) => [c, () => done({ choice: c })])));
      keyHandler(box, (key) => {
        if (choices.includes(key)) done({ choice: key });
        else if (key === "Escape") done({ cancelled: true });
      });
    } else if (spec.kind === "line") {
      const p = document.createElement("p");
      p.textContent = spec.prompt || "";
      box.appendChild(p);
      const input = document.createElement("input");
      input.type = "text";
      input.value = spec.initial || "";
      box.appendChild(input);
      box.appendChild(buttonRow([
        ["OK", () => done({ line: input.value })],
        ["Cancel (Esc)", () => done({ cancelled: true })],
      ]));
      input.focus();
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") done({ line: input.value });
        else if (ev.key === "Escape") done({ cancelled: true });
        ev.stopPropagation();
      });
    } else {
      // menu: items [{id, label, accelerator, selected}]
      const list = document.createElement("ul");
      list.className = "menu";
      const picked = new Set(
        (spec.items || []).filter((i) => i.selected).map((i) => i.id),
      );
      for (const item of spec.items || []) {
        const li = document.createElement("li");
        if (item.disabled || (!item.label && !item.accelerator)) {
          // Shown, not offered: a labeled divider, never a button.
          li.className = "divider";
          if (item.label) li.textContent = item.label;
          list.appendChild(li);
          continue;
        }
        const btn = document.createElement("button");
        btn.textContent = `${item.accelerator ? `[${item.accelerator}] ` : ""}${item.label}`;
        btn.dataset.id = item.id;
        if (picked.has(item.id)) btn.classList.add("picked");
        btn.addEventListener("click", () => {
          if (spec.multi) {
            if (picked.has(item.id)) { picked.delete(item.id); btn.classList.remove("picked"); }
            else { picked.add(item.id); btn.classList.add("picked"); }
          } else {
            done({ ids: [item.id] });
          }
        });
        li.appendChild(btn);
        list.appendChild(li);
      }
      box.appendChild(list);
      const buttons = spec.multi
        ? [["Done", () => done({ ids: [...picked] })], ["Cancel (Esc)", () => done({ cancelled: true })]]
        : [["Cancel (Esc)", () => done({ cancelled: true })]];
      box.appendChild(buttonRow(buttons));
      keyHandler(box, (key) => {
        if (key === "Escape") { done({ cancelled: true }); return; }
        const item = (spec.items || []).find((i) => i.accelerator === key);
        if (item) {
          if (spec.multi) {
            if (picked.has(item.id)) picked.delete(item.id);
            else picked.add(item.id);
            const btn = list.querySelector(`button[data-id="${CSS.escape(String(item.id))}"]`);
            if (btn) btn.classList.toggle("picked", picked.has(item.id));
          } else done({ ids: [item.id] });
        } else if (key === "Enter" && spec.multi) {
          done({ ids: [...picked] });
        }
      });
    }

    overlay.innerHTML = "";
    overlay.appendChild(box);
    const first = box.querySelector("button, input");
    if (first) first.focus();
  }

  function buttonRow(pairs) {
    const row = document.createElement("div");
    row.className = "btnrow";
    for (const [label, fn] of pairs) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      row.appendChild(b);
    }
    return row;
  }

  function keyHandler(box, fn) {
    box.tabIndex = 0;
    box.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      fn(ev.key.length === 1 ? ev.key : ev.key, ev);
    });
  }

  return { show, close };
}
