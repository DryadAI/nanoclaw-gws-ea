/** Server-side Bifrost credential placement. Never serialize these values to logs. */
export function bifrostHeaders(
  apiKey: string | undefined,
  virtualKey: string | undefined,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(virtualKey ? { 'x-bf-vk': virtualKey } : {}),
  };
}
