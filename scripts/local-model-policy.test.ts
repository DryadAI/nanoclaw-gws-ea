import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveLocalProxyModel } from './local-model-policy.js';

test('requires a scoped virtual key and defaults to tested local model', () => {
  assert.equal(resolveLocalProxyModel({ BIFROST_VIRTUAL_KEY: 'test-vk' }), 'ollama/qwen3.5:2b');
  assert.throws(() => resolveLocalProxyModel({}), /virtual key is required/);
});

test('paid and unknown models fail before proxy starts', () => {
  for (const model of ['vllm/kimi-k2.6', 'ollama/qwen3.5:9b', 'openai/gpt-4o']) {
    assert.throws(() => resolveLocalProxyModel({ BIFROST_MODEL: model, BIFROST_VIRTUAL_KEY: 'test-vk' }), /allowlist/);
  }
});

test('HTTP bearer including the legacy shared key is refused', () => {
  assert.throws(() => resolveLocalProxyModel({ BIFROST_VIRTUAL_KEY: 'test-vk', BIFROST_API_KEY: 'sk-dryad-master' }), /forbidden/);
});
