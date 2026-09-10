/** Caller-supplied attribution, never game knowledge or verified model identity. */
export type RunAttribution = {
  control?: string;
  automated?: boolean;
  webmcpAutomated?: boolean;
  harness_name?: string;
  model_name?: string;
};
export function attributionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // oxlint-disable-next-line no-control-regex -- Reject or strip control characters at this text boundary.
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || undefined;
}
export function preserveAttribution<T extends RunAttribution>(old: T | undefined, next: T, acceptProgress = true): T {
  const webmcp = old?.webmcpAutomated === true || old?.control === 'webmcp' || next.webmcpAutomated === true || next.control === 'webmcp';
  const base = !acceptProgress && old ? old : next;
  return {
    ...base,
    ...((old?.control === 'webmcp' || next.control === 'webmcp') && base.control === 'manual' ? { control: 'webmcp' } : {}),
    ...(webmcp ? { webmcpAutomated: true, automated: true } : {}),
    harness_name: attributionName(old?.harness_name) ?? attributionName(next.harness_name),
    model_name: attributionName(old?.model_name) ?? attributionName(next.model_name),
  };
}
