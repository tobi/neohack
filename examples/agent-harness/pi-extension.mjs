// Explicitly loaded by run-pi.mjs; no shell or filesystem tools are registered.
export default async function(pi) {
  const endpoint = process.env.NEOHACK_PI_ENDPOINT;
  const token = process.env.NEOHACK_PI_TOKEN;
  if (!endpoint || !token) throw new Error('Start this extension through run-pi.mjs');
  async function request(path, body) {
    const response = await fetch(endpoint + path, {
      method: body ? 'POST' : 'GET',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `MCP binding HTTP ${response.status}`);
    return result;
  }
  const {tools} = await request('/tools');
  pi.on('session_start', async (_event, ctx) => {
    await request('/ready', {tools: pi.getActiveTools(), model: ctx.model?.id, provider: ctx.model?.provider, contextWindow: ctx.model?.contextWindow});
  });
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args) {
        const result = await request('/call', {name: tool.name, arguments: args});
        return {content: [{type: 'text', text: JSON.stringify(result)}], details: {source: 'neohack-mcp'}};
      },
    });
  }
}
