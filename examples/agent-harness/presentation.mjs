/**
 * Item-only views of a reconstructed public semantic frame (protocol/response.ts).
 * Missing fields are null/unknown, never recovered from slots, glyphs or labels.
 * These views supplement the full frame; do not replace its decisions or receipts.
 *
 * summarizeItems(frame) -> {sessionId, revision, inventory, here}; each collection
 * has {freshness, items}. formatItems(frame) renders that view as compact lines.
 * resolveItemSelection(latestFrame, {sessionId, revision, id, action}) returns
 * {ok:true, item:{id}, sessionId, expectedRevision} or {ok:false, reason}.
 *
 * The caller must supply its latest reconstructed frame immediately before input,
 * serialize dispatch, and keep request IDs, exact receipts and recovery gates.
 * Resolution checks a named action's item only. It does not send input, answer
 * decisions, retry, select a meal or resume an interrupted occupation. Candidate
 * actions are perceived attempts, not promises of safety or success.
 */

const text = value => typeof value === 'string' && value.length > 0 ? value : null;
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string')
  ? [...value] : null;

function collection(observation, location) {
  const inventory = location === 'inventory';
  const source = inventory ? observation?.inventory : observation?.here?.items;
  const known = inventory ? observation?.inventoryKnown : observation?.here?.known;
  const reported = observation?.perception?.[location];
  const freshness = Array.isArray(source) && ['current', 'lastKnown'].includes(reported)
    ? (reported === 'current' && known !== true ? 'unknown' : reported) : 'unknown';
  return {
    freshness,
    items: (Array.isArray(source) ? source : []).map(item => ({
      id: text(item?.id),
      label: text(item?.label),
      appearance: text(item?.known?.appearance),
      identity: text(item?.known?.identity),
      location: ['inventory', 'here'].includes(item?.location) ? item.location : null,
      quantity: Number.isSafeInteger(item?.quantity) ? item.quantity : null,
      actions: strings(item?.actions),
      usage: strings(item?.usage),
      equipmentSlots: strings(item?.equipmentSlots),
    })),
  };
}

export function summarizeItems(frame) {
  return {
    sessionId: text(frame?.sessionId),
    revision: Number.isSafeInteger(frame?.revision) ? frame.revision : null,
    inventory: collection(frame?.observation, 'inventory'),
    here: collection(frame?.observation, 'here'),
  };
}

export function formatItems(frame) {
  const summary = summarizeItems(frame);
  const lines = [
    `items: ${JSON.stringify({ sessionId: summary.sessionId, revision: summary.revision })}`,
    'null = unknown; actions = protocol candidates, not safety guarantees',
  ];
  for (const location of ['inventory', 'here']) {
    const { freshness, items } = summary[location];
    lines.push(`${location} (${freshness}):${items.length ? '' : freshness === 'current' ? ' empty' : ' unknown'}`);
    for (const item of items) lines.push(JSON.stringify(item));
  }
  return lines.join('\n');
}

export function resolveItemSelection(frame, selection) {
  const fail = reason => ({ ok: false, reason });
  if (!text(selection?.sessionId) || selection.sessionId !== frame?.sessionId)
    return fail('sessionMismatch');
  if (!Number.isSafeInteger(selection?.revision) || selection.revision < 0
      || selection.revision !== frame?.revision) return fail('staleRevision');
  if (!frame.observation || frame.ended !== false || frame.end !== null
      || frame.error || frame.historical === true) return fail('frameUnavailable');
  if (frame.update?.kind === 'delta') return fail('unreconstructedDelta');
  if (frame.outcome?.status === 'unknown'
      || [frame.storage, frame.recording].some(state => state && state.status !== 'ok'))
    return fail('recoveryRequired');
  if (frame.decision !== null) return fail('decisionRequired');
  if (!text(selection?.id)) return fail('selectionRequired');
  if (!text(selection?.action)) return fail('actionRequired');

  const summary = summarizeItems(frame);
  const matches = ['inventory', 'here'].flatMap(location =>
    summary[location].items.filter(item => item.id === selection.id)
      .map(item => ({ item, location, freshness: summary[location].freshness })));
  if (!matches.length) return fail('unavailableReference');
  if (matches.length !== 1) return fail('ambiguousReference');
  const { item, location, freshness } = matches[0];
  if (freshness !== 'current') return fail('perceptionNotCurrent');
  if (item.location !== location) return fail('locationMismatch');
  if (item.actions === null) return fail('actionsUnknown');
  if (!item.actions.includes(selection.action)) return fail('actionNotOffered');
  return {
    ok: true,
    item: { id: item.id },
    sessionId: frame.sessionId,
    expectedRevision: frame.revision,
  };
}
