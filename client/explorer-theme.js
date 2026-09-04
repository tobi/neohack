import { css } from "lit";
export const theme = css`
  :host {
    display: block;
    --bg: #10161b;
    --panel: #182127;
    --panel2: #1e2b32;
    --line: #2d3a42;
    --ink: #e5eae7;
    --muted: #93a7b1;
    --accent: #7ae1b5;
    --gold: #e8be79;
    color: var(--ink);
    font:
      14px/1.5 system-ui,
      sans-serif;
  }
  * {
    box-sizing: border-box;
  }
  button,
  input,
  select {
    font: inherit;
  }
  button {
    border: 1px solid var(--line);
    background: var(--panel2);
    color: var(--ink);
    border-radius: 7px;
    padding: 8px 12px;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s;
  }
  button:hover:not(:disabled) {
    background: #30434b;
    border-color: #667f88;
  }
  button:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #10251d;
    font-weight: 700;
  }
  .primary:hover:not(:disabled) {
    background: #a4f4d1;
  }
  .quiet {
    background: transparent;
  }
  .danger {
    border-color: #9a5b57;
    color: #ffb2a7;
  }
  .small {
    font-size: 12px;
    padding: 5px 9px;
  }
  .muted {
    color: var(--muted);
  }
  .eyebrow {
    font:
      600 10px/1.3 ui-monospace,
      monospace;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--muted);
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  h1 {
    font-size: 19px;
    letter-spacing: 0.015em;
  }
  h2 {
    font-size: 16px;
  }
  h3 {
    font-size: 13px;
  }
  code {
    font:
      12px ui-monospace,
      monospace;
  }
  input,
  select {
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #101a20;
    color: var(--ink);
    padding: 8px 10px;
    min-width: 0;
    width: 100%;
  }
  label {
    display: grid;
    gap: 5px;
    color: var(--muted);
    font-size: 12px;
  }
  header {
    height: 76px;
    padding: 0 28px;
    display: flex;
    gap: 20px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    background: #121b20;
  }
  .brand-icon {
    width: 37px;
    height: 37px;
    display: grid;
    place-items: center;
    border: 1px solid #568c76;
    color: var(--accent);
    border-radius: 9px;
    font:
      700 22px ui-monospace,
      monospace;
  }
  .brand {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .top-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pill {
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 5px 10px;
    font-size: 11px;
    color: var(--muted);
  }
  .live {
    color: var(--accent);
  }
  .live::before {
    content: "●";
    margin-right: 6px;
    font-size: 9px;
  }
  .notice {
    padding: 9px 28px;
    color: #b7c3c4;
    background: #182323;
    font-size: 12px;
    border-bottom: 1px solid var(--line);
  }
  .notice strong {
    color: var(--gold);
  }
  main {
    padding: 22px 26px;
    max-width: 1900px;
    margin: auto;
  }
  .stats {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    align-items: stretch;
  }
  .hero {
    min-width: 240px;
    flex: 1;
    padding: 5px 0;
  }
  .hero h2 {
    font-size: 21px;
    font-weight: 650;
  }
  .stat {
    min-width: 106px;
    padding: 10px 16px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--panel);
  }
  .stat strong {
    font-size: 21px;
    display: block;
    font-weight: 650;
  }
  .stat.hp {
    min-width: 170px;
  }
  .meter {
    height: 4px;
    background: #34434b;
    border-radius: 3px;
    margin-top: 7px;
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .conditions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .tag {
    font-size: 11px;
    color: var(--gold);
    background: #343125;
    border-radius: 4px;
    padding: 2px 7px;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 330px;
    gap: 18px;
  }
  .panel {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    overflow: hidden;
  }
  .panel-head {
    padding: 13px 17px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--line);
  }
  .panel-head h2 {
    font-size: 13px;
    font-weight: 600;
  }
  .map-toolbar {
    display: flex;
    gap: 7px;
    align-items: center;
  }
  .map-area {
    height: 490px;
    min-height: 330px;
    background: #111a20;
    position: relative;
    outline: none;
  }
  .map-footer {
    display: flex;
    gap: 16px;
    justify-content: space-between;
    align-items: center;
    padding: 10px 17px;
    border-top: 1px solid var(--line);
    font:
      11px ui-monospace,
      monospace;
    color: var(--muted);
  }
  .legend {
    display: flex;
    gap: 14px;
  }
  .legend span::before {
    content: "■";
    font-size: 10px;
    margin-right: 5px;
  }
  .legend .lself {
    color: var(--accent);
  }
  .legend .lally {
    color: #83a9e0;
  }
  .legend .lmonster {
    color: #e39c89;
  }
  .empty {
    display: grid;
    gap: 14px;
    max-width: 360px;
    text-align: center;
    color: var(--muted);
    padding: 35px;
  }
  .empty-icon {
    font:
      48px ui-monospace,
      monospace;
    color: #5f837e;
  }
  .empty h2 {
    color: var(--ink);
    font-size: 20px;
  }
  .left {
    min-width: 0;
  }
  .controls {
    display: flex;
    gap: 18px;
    margin-top: 15px;
    align-items: start;
  }
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 38px);
    gap: 4px;
  }
  .dpad button {
    padding: 4px;
    font-size: 19px;
    height: 33px;
  }
  .action-space {
    flex: 1;
  }
  .action-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 7px 0;
  }
  .action-row button {
    font-size: 12px;
    padding: 7px 10px;
  }
  .action-row .selected {
    border-color: var(--accent);
    color: var(--accent);
  }
  .control-help {
    font-size: 11px;
    margin-top: 8px;
    color: var(--muted);
  }
  .journal {
    margin-top: 17px;
  }
  .journal-list {
    height: 190px;
    overflow: auto;
    padding: 4px 17px 12px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .log {
    padding: 8px 0;
    display: flex;
    gap: 13px;
    border-bottom: 1px solid #25323a;
    font-size: 12px;
  }
  .log .turn {
    min-width: 38px;
    font:
      10px ui-monospace,
      monospace;
    color: #6e9398;
    padding-top: 3px;
  }
  .log.system {
    color: var(--muted);
  }
  .log.error {
    color: #ffb5a6;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }
  .card-body {
    padding: 16px;
  }
  .setup {
    display: grid;
    gap: 12px;
  }
  .setup .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .inventory {
    max-height: 360px;
    overflow: auto;
    display: grid;
  }
  .inventory button {
    text-align: left;
    border: 0;
    border-bottom: 1px solid #293940;
    border-radius: 0;
    display: flex;
    gap: 10px;
    align-items: start;
    padding: 13px 16px;
    background: transparent;
  }
  .inventory button.selected {
    background: #233d36;
    box-shadow: inset 3px 0 var(--accent);
  }
  .item-icon {
    font:
      19px ui-monospace,
      monospace;
    color: var(--gold);
    min-width: 18px;
  }
  .item-detail {
    font-size: 12px;
  }
  .item-id {
    font:
      10px ui-monospace,
      monospace;
    color: var(--muted);
    margin-top: 3px;
  }
  .statusline {
    font-size: 12px;
    color: var(--muted);
    padding: 10px 16px;
    border-top: 1px solid var(--line);
  }
  .selection-text {
    font-size: 12px;
    padding: 11px 15px;
    background: #21302e;
    color: #b7d5c8;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .selection-text button {
    margin-left: auto;
  }
  .details {
    font-size: 12px;
    display: grid;
    gap: 8px;
  }
  .details .line {
    display: flex;
    justify-content: space-between;
    gap: 15px;
  }
  .error-banner {
    padding: 12px 15px;
    margin-bottom: 14px;
    border: 1px solid #884e46;
    background: #382420;
    color: #f1bdb0;
    border-radius: 8px;
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .error-banner button {
    margin-left: auto;
    white-space: nowrap;
  }
  .decision {
    border-color: #6f8874;
    box-shadow: 0 0 0 1px #7ae1b518;
  }
  .decision .panel-head {
    background: #213b31;
  }
  .decision .panel-head .eyebrow {
    color: var(--accent);
  }
  .decision-about {
    font-size: 16px;
    padding-bottom: 12px;
  }
  .options {
    display: grid;
    gap: 7px;
    max-height: 280px;
    overflow: auto;
    margin: 12px 0;
  }
  .option {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
    font-size: 12px;
    width: 100%;
  }
  .option span {
    color: var(--muted);
  }
  .option.selected {
    border-color: var(--accent);
    background: #254338;
  }
  .decision-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .target-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 5px;
    margin-bottom: 12px;
  }
  .target-grid button {
    font-size: 11px;
  }
  .debug {
    max-height: 200px;
    overflow: auto;
    font-size: 10px;
    white-space: pre-wrap;
    color: var(--muted);
  }
  details {
    padding: 12px 16px;
    font-size: 11px;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
  }
  .end {
    border-color: var(--gold);
  }
  .kbd {
    font:
      10px ui-monospace,
      monospace;
    border: 1px solid #3b4f58;
    border-radius: 3px;
    padding: 1px 4px;
  }
  footer {
    padding: 0 27px 18px;
    color: #667d85;
    font:
      10px ui-monospace,
      monospace;
    display: flex;
    justify-content: space-between;
  }
  @media (min-width: 1550px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) 365px;
    }
    .map-area {
      height: 510px;
    }
  }
  @media (max-width: 1000px) {
    .stats {
      flex-wrap: wrap;
    }
    .hero {
      width: 100%;
    }
    .stat {
      flex: 1;
    }
    .layout {
      grid-template-columns: 1fr 280px;
    }
    main {
      padding: 16px;
    }
    .top-actions .pill {
      display: none;
    }
    .brand .eyebrow {
      display: none;
    }
  }
  @media (max-width: 760px) {
    header {
      height: auto;
      min-height: 76px;
      padding: 12px 15px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .top-actions {
      margin-left: 0;
      flex-wrap: wrap;
    }
    .notice {
      padding: 8px 15px;
    }
    .layout {
      grid-template-columns: 1fr;
    }
    .sidebar {
      order: 0;
    }
    .map-area {
      height: 370px;
    }
    .stat {
      padding: 8px 10px;
      min-width: 85px;
    }
    .stat.hp {
      min-width: 140px;
    }
    .hero {
      min-width: 100%;
    }
    .map-footer {
      flex-wrap: wrap;
    }
    .controls {
      gap: 12px;
    }
    .journal-list {
      height: 160px;
    }
    footer {
      flex-wrap: wrap;
      gap: 8px;
    }
  }

  .setup-panel.first {
    order: -1;
  }
  nh-map3d {
    width: 100%;
    height: 100%;
  }
  .mode-tabs {
    display: flex;
    gap: 5px;
    margin-left: 15px;
  }
  .mode-tabs button[aria-pressed="true"] {
    color: var(--accent);
    border-color: #6b9f85;
  }
  .timeline {
    padding: 14px 17px;
    border-top: 1px solid var(--line);
    background: #1c2b30;
  }
  .timeline-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .timeline-head select {
    width: auto;
  }
  .timeline input[type="range"] {
    padding: 0;
    margin: 12px 0 5px;
    accent-color: var(--accent);
  }
  .timeline-labels {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font:
      11px ui-monospace,
      monospace;
  }
  .run-list {
    max-height: 290px;
    overflow: auto;
    display: grid;
    gap: 7px;
  }
  .run-row {
    display: grid;
    gap: 4px;
    text-align: left;
    padding: 11px;
    font-size: 12px;
  }
  .run-row span {
    font-size: 10px;
    color: var(--muted);
  }
  .replay-badge {
    color: var(--gold);
    border-color: #796039;
  }
  .replay-summary {
    font-size: 13px;
    display: flex;
    gap: 12px;
    padding: 14px 17px;
    margin-top: 14px;
    align-items: center;
  }
  .timeline a {
    color: var(--accent);
    margin-left: auto;
    font-size: 12px;
  }
  .run-actions {
    display: flex;
    gap: 7px;
    margin-bottom: 10px;
  }
  .file-input {
    display: none;
  }
  .provenance-banner,
  .reconstruction-status {
    padding: 12px 15px;
    border: 1px solid #77613d;
    border-radius: 8px;
    background: #302a20;
    color: #e8cc9d;
    font-size: 12px;
    margin-bottom: 14px;
  }
  .provenance-banner p,
  .reconstruction-status p {
    margin: 6px 0;
  }
  .provenance-banner span {
    font:
      10px ui-monospace,
      monospace;
  }
  .run-row span {
    overflow-wrap: anywhere;
  }
  .toolbar-info {
    font:
      10px ui-monospace,
      monospace;
    color: var(--muted);
  }
`;
