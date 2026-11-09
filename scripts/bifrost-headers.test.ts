import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bifrostHeaders } from './bifrost-headers.js';

test('virtual key uses governance header without an admin bearer', () => {
  assert.deepEqual(bifrostHeaders(undefined, 'vk-test'), {
    'Content-Type': 'application/json',
    'x-bf-vk': 'vk-test',
  });
});

test('dual credentials stay in separate headers during transition', () => {
  assert.deepEqual(bifrostHeaders('auth-test', 'vk-test'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer auth-test',
    'x-bf-vk': 'vk-test',
  });
});

test('no virtual key is invented for legacy callers', () => {
  assert.deepEqual(bifrostHeaders('auth-test', undefined), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer auth-test',
  });
});
