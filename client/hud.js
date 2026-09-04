// hud.js — status + message log. No game rules: pure render of server data.
// Server notifications consumed: `message` {text}, `status` {…fields},
// `inventory` {items}, `session_started/ended`, `snapshot` (initial fill).

export function createHud(root) {
  root.innerHTML = `
    <div class="hud-name">—</div>
    <div class="bars"></div>
    <div class="statgrid"></div>
    <div class="hud-msg"></div>
    <details class="hud-inv"><summary>Inventory</summary><ul></ul></details>
  `;
  const nameEl = root.querySelector(".hud-name");
  const barsEl = root.querySelector(".bars");
  const gridEl = root.querySelector(".statgrid");
  const msgEl = root.querySelector(".hud-msg");
  const invList = root.querySelector(".hud-inv ul");

  // Grid order: the numbers a player checks mid-run.
  const GRID = ["ac", "gold", "xp", "leveldesc", "time", "hunger", "align",
    "hd", "str", "dx", "co", "in", "wi", "ch", "cap", "score", "condition"];

  return {
    setStatus(s = {}) {
      const name = s.name ?? s.title ?? "";
      nameEl.textContent = name === "" ? "—" : String(name);
      nameEl.style.display = name === "" ? "none" : "";
      barsEl.innerHTML =
        bar("hp", "HP", s.hp, s.hpmax) + bar("en", "EN", s.ene, s.enemax);
      gridEl.innerHTML = GRID.filter((k) => {
        const v = s[k];
        return v !== undefined && v !== null && v !== "";
      }).map((k) => `<div><div class="k">${escapeHtml(shortLabel(k))}</div>` +
        `<div class="v">${escapeHtml(cleanValue(s[k]))}</div></div>`).join("");
    },
    pushMessage(text, kind) {
      const div = document.createElement("div");
      if (kind) div.className = kind;
      div.textContent = String(text ?? "");
      msgEl.prepend(div);
      while (msgEl.children.length > 200) msgEl.lastChild.remove();
    },
    setInventory(items = []) {
      invList.innerHTML = "";
      for (const it of items) {
        const li = document.createElement("li");
        li.textContent = typeof it === "string" ? it : (it.label || JSON.stringify(it));
        invList.appendChild(li);
      }
    },
    clear() {
      nameEl.textContent = "—";
      barsEl.innerHTML = "";
      gridEl.innerHTML = "";
      msgEl.innerHTML = "";
      invList.innerHTML = "";
    },
  };

  function bar(cls, label, cur, max) {
    if (cur === undefined || max === undefined || max === null) return "";
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    return `<div class="bar ${cls}">${label}<span class="track">` +
      `<span class="fill" style="width:${pct.toFixed(0)}%"></span></span>` +
      `<span class="num">${escapeHtml(String(cur))}/${escapeHtml(String(max))}</span></div>`;
  }

  function shortLabel(k) {
    return { leveldesc: "depth", hunger: "hunger", align: "align" }[k] ?? k;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// The engine occasionally leaks tty attribute codes into status values
// (e.g. gold arrives as "\G1C440F2E:1952"). Display-only cleanup.
function cleanValue(s) {
  return String(s).replace(/\\[A-Za-z][0-9A-Fa-f]*:/, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
