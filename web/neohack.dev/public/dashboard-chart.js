// Presentation of public ledger summaries only; no gameplay or replay downloads.
export const classes = Object.assign(Object.create(null), {
  archeologist: ['Archeologist', '#d9bd83'], barbarian: ['Barbarian', '#ed927e'],
  caveman: ['Caveman', '#c9a589'], healer: ['Healer', '#99d7b4'],
  knight: ['Knight', '#aec5e8'], monk: ['Monk', '#e8b36e'],
  priest: ['Priest', '#d4b6e7'], ranger: ['Ranger', '#b3cf88'],
  rogue: ['Rogue', '#e3a2bd'], samurai: ['Samurai', '#c2cde0'],
  tourist: ['Tourist', '#e0d986'], valkyrie: ['Valkyrie', '#88cad8'],
  wizard: ['Wizard', '#afabeb'],
});
export const classKey = run => String(run.actualClass ?? run.role ?? '').toLowerCase();
export const classInfo = run => classes[classKey(run)] ?? ['Unknown class', '#a6b1ad'];
const number = value => Number(value).toLocaleString();
const known = value => Number.isSafeInteger(value) && value > 0;
export const metricValue = (run, metric) => run[metric === 'level' ? 'maxLevel' : 'maxDepth'];
export function node(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function svg(tag, attrs = {}, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text; return el;
}
const ticks = max => {
  const raw = Math.max(1, max) / 4, power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * power >= raw) * power);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({length: Math.round(top / step) + 1}, (_, i) => i * step);
};
const outcome = run => run.ended ? run.endKind ?? 'Ended' : 'Adventuring';

export function runChart(onReplay) {
  const host = document.querySelector('#run-chart'), legend = document.querySelector('#class-legend');
  const info = document.querySelector('#selected-run'), select = document.querySelector('#chart-metric');
  let runs = [], filter = '', selectedId, loaded = false;
  function choose(run) {
    selectedId = run.id;
    const [label, color] = classInfo(run), identity = node('div', undefined, 'plot-identity');
    identity.append(node('strong', run.name), node('span', label, 'class-name'));
    identity.style.setProperty('--class-color', color);
    const facts = node('p', `${number(run.turn)} turns · Hero level ${known(run.maxLevel) ? run.maxLevel : 'unknown'} · Depth ${known(run.maxDepth) ? run.maxDepth : 'unknown'} · ${outcome(run)}`);
    const copy = node('div'); copy.append(identity, facts);
    info.replaceChildren(copy);
    const overlaps = visible().filter(r => r.turn === run.turn && metricValue(r, select.value) === metricValue(run, select.value));
    if (overlaps.length > 1) {
      const label = node('label', `${overlaps.length} runs at this point`, 'overlap-choice'), options = node('select');
      options.setAttribute('aria-label', 'Runs at the selected point');
      for (const candidate of overlaps) { const option = node('option', `${candidate.name} · ${classInfo(candidate)[0]}`); option.value = candidate.id; options.append(option); }
      options.value = run.id; options.onchange = () => choose(overlaps.find(r => r.id === options.value)); label.append(options); info.append(label);
    }
    if (run.replayAvailable) { const button = node('button', 'Show replay', 'run-replay'); button.onclick = () => onReplay(run); info.append(button); }
    for (const point of host.querySelectorAll('[data-run]')) {
      const active = point.dataset.run === run.id; point.classList.toggle('selected', active); point.setAttribute('aria-pressed', String(active));
    }
  }
  const visible = () => runs.filter(run => !filter || classKey(run) === filter);
  function draw() {
    const metric = select.value, candidates = visible();
    const plotted = candidates.filter(run => Number.isSafeInteger(run.turn) && run.turn >= 0 && known(metricValue(run, metric)));
    const count = document.querySelector('#plot-count');
    count.textContent = loaded ? `${runs.length} latest updated runs${filter ? ` · ${candidates.length} ${classes[filter]?.[0] ?? 'unknown class'}` : ''}` : 'Loading recent runs…';
    const missing = candidates.length - plotted.length;
    document.querySelector('#plot-missing').textContent = missing ? `${missing} ${missing === 1 ? 'run has' : 'runs have'} no recorded ${metric === 'level' ? 'hero level' : 'depth'} and ${missing === 1 ? 'is' : 'are'} omitted from the plot.` : '';
    if (!plotted.length) {
      host.replaceChildren(node('p', loaded ? candidates.length ? 'No values recorded for this view.' : 'No recent adventures yet.' : 'Loading the plot…', 'chart-empty'));
      info.replaceChildren(node('p', 'Select a dot to see the adventurer.')); return;
    }
    const width = Math.max(280, host.clientWidth), height = 284, margin = {left: 45, right: 18, top: 15, bottom: 42};
    const xticks = ticks(Math.max(...plotted.map(r => r.turn))), yticks = ticks(Math.max(...plotted.map(r => metricValue(r, metric))));
    const x = value => margin.left + value / xticks.at(-1) * (width - margin.left - margin.right);
    const y = value => height - margin.bottom - value / yticks.at(-1) * (height - margin.top - margin.bottom);
    const chart = svg('svg', {viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': `Turns and ${metric === 'level' ? 'best hero level' : 'deepest dungeon level'} for recent runs`, 'aria-describedby': 'plot-help'});
    for (const value of yticks) {
      chart.append(svg('line', {x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value), class: 'plot-grid'}));
      chart.append(svg('text', {x: margin.left - 10, y: y(value) + 4, 'text-anchor': 'end', class: 'tick'}, number(value)));
    }
    for (const value of xticks) chart.append(svg('text', {x: x(value), y: height - 23, 'text-anchor': 'middle', class: 'tick'}, Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1}).format(value)));
    chart.append(svg('text', {x: (width + margin.left) / 2, y: height - 3, 'text-anchor': 'middle', class: 'axis-title'}, 'Turns survived'));
    plotted.forEach((run, i) => {
      const value = metricValue(run, metric), [label, color] = classInfo(run);
      const point = svg('g', {transform: `translate(${x(run.turn)},${y(value)})`, role: 'button', tabindex: i === 0 ? 0 : -1, 'aria-label': `${run.name}, ${label}, ${number(run.turn)} turns, ${metric === 'level' ? 'hero level' : 'depth'} ${value}`, 'data-run': run.id, 'aria-pressed': false, class: 'run-point'});
      point.append(svg('circle', {r: 13, fill: 'transparent', class: 'point-hit'}));
      point.append(svg('circle', {r: 4.5, fill: color, class: 'point-mark'}));
      point.onpointerenter = () => choose(run); point.onfocus = () => choose(run); point.onclick = () => choose(run);
      point.onkeydown = event => {
        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? plotted.length - 1 : (i + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + plotted.length) % plotted.length;
          const points = chart.querySelectorAll('[data-run]'); point.setAttribute('tabindex', '-1'); points[next].setAttribute('tabindex', '0'); points[next].focus();
        } else if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); choose(run);}
      };
      chart.append(point);
    });
    host.replaceChildren(chart);
    const selected = plotted.find(r => r.id === selectedId);
    if (selected) choose(selected); else {selectedId = undefined; info.replaceChildren(node('p', 'Select a dot to see the adventurer.'));}
  }
  function updateLegend() {
    const counts = new Map(); for (const run of runs) counts.set(classKey(run), (counts.get(classKey(run)) ?? 0) + 1);
    const button = (key, label, color, count) => {
      const b = node('button', undefined, 'class-filter'); b.type = 'button'; b.setAttribute('aria-pressed', String(filter === key)); b.dataset.class = key;
      const swatch = node('span', '', 'class-swatch'); swatch.style.background = color; swatch.setAttribute('aria-hidden', 'true');
      b.append(swatch, node('span', label), node('small', count));
      b.onclick = () => {filter = filter === key ? '' : key; selectedId = undefined; for (const other of legend.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other.dataset.class === filter)); draw();}; return b;
    };
    legend.replaceChildren(button('', 'All classes', '#d7d3be', runs.length), ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => button(key, classes[key]?.[0] ?? 'Unknown', classes[key]?.[1] ?? '#a6b1ad', count)));
  }
  select.onchange = () => {selectedId = undefined; draw();};
  new ResizeObserver(() => draw()).observe(host);
  return {
    update(next) {
      loaded = true; runs = next.slice(0, 200); if (filter && !runs.some(r => classKey(r) === filter)) filter = '';
      updateLegend(); draw();
      const body = document.querySelector('#recent-runs');
      body.replaceChildren(...runs.map(run => {
        const row = node('tr'); for (const value of [run.name, classInfo(run)[0], number(run.turn), known(run.maxLevel) ? run.maxLevel : '—', known(run.maxDepth) ? run.maxDepth : '—', outcome(run)]) row.append(node('td', value));
        const last = node('td'); if (run.replayAvailable) {const b = node('button', 'Show replay', 'run-replay'); b.onclick = () => onReplay(run); last.append(b);} row.append(last); return row;
      }));
    },
  };
}

export function renderRecords(records, onReplay) {
  const host = document.querySelector('#period-records');
  host.replaceChildren(...[['today', 'Today', 'Since midnight UTC'], ['week', 'Last 7 days', 'Today + previous 6 UTC days']].map(([key, title, subtitle]) => {
    const data = records?.[key], section = node('section', undefined, 'record-period');
    const heading = node('div', undefined, 'period-heading'); heading.append(node('h3', title), node('span', `${subtitle} · ${number(data?.runs ?? 0)} updated runs`)); section.append(heading);
    const columns = node('div', undefined, 'record-columns');
    for (const [metric, label] of [['level', 'Hero level'], ['depth', 'Dungeon depth']]) {
      const column = node('div', undefined, 'record-list'); column.dataset.period = key; column.dataset.metric = metric; column.append(node('h4', label));
      const entries = data?.[metric] ?? [];
      if (!entries.length) column.append(node('p', data ? 'None recorded yet.' : 'Records unavailable.', 'record-empty'));
      entries.forEach((run, i) => {
        const row = node('div', undefined, 'record-row'), [role, color] = classInfo(run);
        row.append(node('span', i + 1, 'record-rank'));
        const copy = node('div', undefined, 'record-hero'); copy.style.setProperty('--class-color', color);
        const name = node(run.replayAvailable ? 'button' : 'strong', run.name); name.title = run.name;
        if (run.replayAvailable) {name.setAttribute('aria-label', 'Show replay for ' + run.name); name.onclick = () => onReplay(run);}
        copy.append(name, node('small', role)); row.append(copy, node('strong', metricValue(run, metric), 'record-value')); column.append(row);
      });
      columns.append(column);
    }
    section.append(columns); return section;
  }));
}
