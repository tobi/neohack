/** Small control icons; their buttons retain complete accessible action names. */
const paths: Record<string, string> = {
  wield: 'M5 19 19 5V2h-3L5 13m-2-2 10 10M3 21l4-4',
  drop: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  pickup: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  equip: 'm8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4c0 4-8 4-8 0Z',
  remove: 'm8 3-6 4 3 5 3-2v11h8v-7m0-11c0 4-8 4-8 0m8 5h6',
  eat: 'M12 7c-7-5-12 4-7 12 2 4 5 1 7 1s5 3 7-1c5-8 0-17-7-12Zm0 0c0-4 3-5 5-5',
  drink: 'M9 2h6m-5 0v6l-5 9c-1 3 1 5 3 5h8c2 0 4-2 3-5l-5-9V2M7 14h10',
  read: 'M12 5v16M3 3c4-1 7 0 9 2 2-2 5-3 9-2v16c-4-1-7 0-9 2-2-2-5-3-9-2V3Z',
  zap: 'm4 21 12-12m-2-2 4 4M5 2v6M2 5h6m11 10v6m-3-3h6M17 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z',
  apply: 'M21 3a6 6 0 0 1-8 8L5 21l-3-3 10-8a6 6 0 0 1 8-8l-4 4 2 2 4-4',
};
export function actionIcon(action: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${paths[action] ?? 'M5 12h14m-7-7v14'}"/></svg>`;
}
