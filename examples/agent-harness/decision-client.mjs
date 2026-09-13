/** One live MCP session. Transport journals exact calls; uncertainty stops input.
 * The shared SceneReader owns scene delivery. No old snapshot reconstruction,
 * automatic view binding, compensating observation, or gameplay retry. */
export function createDecisionClient({sessionId, tools, send, reader}) {
  if (!sessionId || !Array.isArray(tools) || typeof send !== 'function' || !reader)
    throw new TypeError('A session, discovered tools, transport and SceneReader are required.');
  const catalog = new Map(tools.map(tool => [tool.name, tool]));
  let current = null, uncertain = false, needsScene = false, ownershipLost = false, tail = Promise.resolve();
  const recovery = () => ownershipLost ? 'ownership' : uncertain ? 'receipt' : needsScene ? 'scene' : null;
  function accept(frame) {
    if (frame?.version !== 2) throw new Error('DecisionFrame v2 required.');
    if (frame.basis && frame.basis.sessionId !== sessionId) throw new Error('Wrong session.');
    const received = reader.apply(frame);
    if (received.scene) current = received;
    return received;
  }
  function call(input) {
    const request = structuredClone(input);
    const run = tail.then(async () => {
      const tool = catalog.get(request.name), args = request.arguments;
      if (!tool || !args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Unknown tool or malformed arguments.');
      if (args.sessionId !== undefined && args.sessionId !== sessionId)
        throw new Error('Wrong session.');
      if (['create', 'resume', 'suspend'].includes(request.name))
        throw new Error('Session lifecycle belongs to the run owner.');
      if (tool.inputSchema.properties?.sessionId) request.arguments = {...args, sessionId};
      const readOnly = tool.annotations?.readOnlyHint === true;
      if (!readOnly) {
        if (recovery() || !current || !['ready', 'decision'].includes(current.control.gate))
          throw new Error('Input is blocked; use syncState for a fresh scene or exact receipt verification.');
        if (['answer', 'cancel'].includes(request.name)) {
          if (!current.decision || args.decisionId !== current.decision.id)
            throw new Error('The exact standing decision ID is required.');
          if (request.name === 'cancel' && !current.decision.cancel)
            throw new Error('This decision does not offer cancellation.');
        } else {
          if (current.control.gate !== 'ready') throw new Error('Resolve the standing decision explicitly.');
          if (args.viewId !== current.basis.viewId)
            throw new Error('The explicit viewId must match the held scene; no input sent.');
        }
      }
      let frame;
      try { frame = accept(await send(request)); }
      catch (error) {
        needsScene = true;
        if (!readOnly) uncertain = true;
        throw error;
      }
      if (frame.outcome?.submission === 'unknown' ||
          frame.control.gate === 'recoveryRequired') uncertain = true;
      if (frame.control.gate === 'ownershipLost') ownershipLost = true;
      if (frame.error?.code === 'staleView' ||
          (frame.control.gate === 'unavailable' && tool.inputSchema.properties?.sessionId)) needsScene = true;
      // A read failure has no input receipt to settle. Only an explicit fresh
      // sync repairs its scene; an unresolved mutation still requires verification.
      if (request.name === 'syncState' && !frame.error && frame.basis?.sessionId === sessionId &&
          frame.scene?.kind === 'snapshot' && ['ready', 'decision', 'ended'].includes(frame.control.gate) &&
          frame.outcome?.submission !== 'unknown') {
        needsScene = false;
        if (frame.verification?.status === 'settled') uncertain = false;
      }
      return frame;
    });
    tail = run.catch(() => {});
    return run;
  }
  return Object.freeze({accept, call, current: () => structuredClone(current), blocked: () => recovery() !== null, recovery});
}
