// The proxy is a local-only pilot. Expansion requires an explicit reviewed change.
export const LOCAL_PROXY_MODEL = 'ollama/qwen3.5:2b';

export function resolveLocalProxyModel(env: Record<string, string | undefined>): string {
  const model = env.BIFROST_MODEL ?? env.OLLAMA_MODEL ?? LOCAL_PROXY_MODEL;
  if (model !== LOCAL_PROXY_MODEL) throw new Error('Proxy model is not in the local-only allowlist');
  if (!env.BIFROST_VIRTUAL_KEY?.trim()) throw new Error('Scoped Bifrost virtual key is required');
  if (env.BIFROST_API_KEY?.trim()) throw new Error('HTTP bearer is forbidden in VK-only pilot mode');
  return model;
}
