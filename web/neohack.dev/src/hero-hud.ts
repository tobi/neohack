import type { Observation } from "neonethack/types";
import { characterStatus } from "./character-status";
import { inventoryArt } from "./symbol-art";
const escape = (text: unknown) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function renderHeroHud(host: HTMLElement, o: Observation) {
  const get = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  const v = o.vitals;
  const fraction = Number(v.health) / Number(v.maxHealth);
  const hunger = String(v.hunger ?? "");
  const hungry = ["hungry", "weak", "fainting", "fainted", "starved"].includes(
    hunger,
  );
  const severeHunger = hungry && hunger !== "hungry";
  const danger =
    fraction <= 0.2 || ["fainting", "fainted", "starved"].includes(hunger);
  const warning = fraction <= 0.4 || severeHunger;
  get(".hero-hud").dataset.urgency = danger
    ? "danger"
    : warning
      ? "warning"
      : "normal";
  for (const button of host.querySelectorAll<HTMLElement>(
    '[data-action="eat"], [data-action="pray"]',
  )) {
    if (button.closest(".action-grid") && button.dataset.action === "eat") button.hidden = !hungry;
    const active = button.dataset.action === "eat" ? hungry : danger;
    button.classList.toggle("action-cue", active);
    button.setAttribute(
      "aria-label",
      button.dataset.action === "eat"
        ? hungry
          ? "Eat · you are hungry"
          : "Eat"
        : danger
          ? "Pray · ask for help; safety unknown"
          : "Pray",
    );
  }
  const weapons = o.inventory.filter(
    (item) =>
      item.equipmentSlots?.includes("weapon") ||
      item.equipmentSlots?.includes("offhand"),
  );
  const weapon =
    o.perception.equipment === "current" &&
    o.perception.inventory === "current" &&
    o.inventoryKnown &&
    o.inventory.every((item) => item.equipmentSlots !== undefined)
      ? weapons.map((item) => item.label).join(" · ") || "Empty hands"
      : "Equipment unknown";
  get("#hero-level").innerHTML =
    `<small>HERO LEVEL</small><strong>${escape(v.level ?? "?")}</strong>`;
  const weaponIcons =
    weapon !== "Equipment unknown"
      ? weapons
          .map((item) => `<img src="${inventoryArt(item)}" alt="">`)
          .join("")
      : "";
  const { conditions } = characterStatus(o);
  get("#character-stats").innerHTML =
    `<div class="health-label"><span>Health</span><strong>${escape(v.health ?? "?")} <span>/ ${escape(v.maxHealth ?? "?")}</span></strong></div><progress aria-label="Health" max="100" value="${Number.isFinite(fraction) ? Math.max(0, Math.min(100, fraction * 100)) : 0}"></progress><div class="stats-row"><div><small>ARMOR</small><strong>${escape(v.armor ?? "?")}</strong></div><div><small>GOLD</small><strong>${escape(v.gold ?? "?")}</strong></div></div><p class="weapon-line" title="${escape(weapon)}">${weaponIcons}<span>${escape(weapon)}</span></p><p class="condition" ${conditions ? "" : "hidden"}>${escape(conditions)}</p>`;
}
