import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { RubyRuntime } from '../worker/runtime.js';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
const request = length => ({ operation: 'crypto.random_bytes', binding: '', args: [String(length)] });

test('Web Crypto binding validates requests and propagates provider failures', async () => {
  const adapter = new BindingAdapter({}, {});
  const result = await adapter.invoke(request(65536));
  assert.equal(result.bytes.length, 65536);
  assert.ok(result.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
  for (const length of [-1, 65537, 1.5, 'NaN', '', '01']) {
    await assert.rejects(adapter.invoke(request(length)), /random byte|Random byte/);
  }
  await assert.rejects(adapter.invoke({ ...request(1), binding: 'CRYPTO' }), /Invalid random byte/);
  await assert.rejects(adapter.invoke({ ...request(1), args: [1] }), /Invalid random byte/);
  const original = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = () => { throw new Error('crypto failed'); };
  try { await assert.rejects(adapter.invoke(request(1)), /crypto failed/); }
  finally { globalThis.crypto.getRandomValues = original; }
});

test('SecureRandom crosses the real Ruby/Wasm binding and preserves all bytes', async () => {
  const adapter = new BindingAdapter({}, {});
  const runtime = new RubyRuntime(module);
  const calls = [];
  const original = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = bytes => {
    calls.push(bytes.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    return bytes;
  };
  const dispatch = (args, method = 'bytes') => runtime.dispatch({ class: 'SecureRandomProbe', id: 'bytes', type: 'rpc',
    payload: { method, args } }, request => adapter.invoke(request));
  try {
    const defaults = await dispatch([]);
    assert.equal(defaults.ok, true, defaults.error);
    assert.deepEqual(defaults.value, Array.from({ length: 16 }, (_, i) => i));
    assert.deepEqual((await dispatch([null])).value, defaults.value);
    const empty = await dispatch([0]);
    assert.equal(empty.ok, true, empty.error);
    assert.deepEqual(empty.value, []);
    calls.length = 0;
    const large = await dispatch([65537]);
    assert.equal(large.ok, true, large.error);
    assert.equal(large.value.length, 65537);
    assert.deepEqual(large.value.slice(0, 256), Array.from({ length: 256 }, (_, i) => i));
    assert.deepEqual(calls, [65536, 1]);
    const hex = await dispatch([256], 'hex');
    assert.equal(hex.ok, true, hex.error);
    assert.equal(hex.value, Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('hex'));
    const defaultHex = await dispatch([], 'hex');
    assert.equal(defaultHex.ok, true, defaultHex.error);
    assert.equal(defaultHex.value, '000102030405060708090a0b0c0d0e0f');
    assert.equal((await dispatch([null], 'hex')).value, defaultHex.value);
    assert.equal((await dispatch([0], 'hex')).value, '');
    for (const length of [-1, 1.5, '16']) assert.equal((await dispatch([length])).ok, false);
    for (const length of [-1, 1.5, '16']) assert.equal((await dispatch([length], 'hex')).ok, false);
    globalThis.crypto.getRandomValues = () => { throw new Error('crypto failed'); };
    assert.deepEqual(await dispatch([1]), { ok: false, error: 'crypto failed' });
    assert.deepEqual(await dispatch([1], 'hex'), { ok: false, error: 'crypto failed' });
  } finally {
    globalThis.crypto.getRandomValues = original;
    runtime.destroy();
  }
});

test('SecureRandom numbers stay within bounds and reject biased integer samples', async () => {
  const adapter = new BindingAdapter({}, {});
  const runtime = new RubyRuntime(module);
  const dispatch = (args, method = 'number') => runtime.dispatch({ class: 'SecureRandomProbe', id: 'numbers', type: 'rpc',
    payload: { method, args } }, request => adapter.invoke(request));
  const original = globalThis.crypto.getRandomValues;
  try {
    for (const limit of [0, -1, 0.5, 10.5, 1, 3, 256, 257, 2147483648]) {
      const result = await dispatch([limit]);
      assert.equal(result.ok, true, result.error);
      const value = Number(result.value.value);
      assert.ok(value >= 0 && value < (limit > 0 ? limit : 1), JSON.stringify(result));
      assert.equal(result.value.integer, Number.isInteger(limit) && limit > 0);
    }
    globalThis.crypto.getRandomValues = bytes => bytes.fill(255);
    const maximumFloat = await dispatch([]);
    assert.equal(maximumFloat.ok, true, maximumFloat.error);
    assert.equal(Number(maximumFloat.value.value), 1 - 2 ** -53);
    const maximumInteger = await dispatch([(1n << 62n).toString()], 'integer_number');
    assert.equal(maximumInteger.ok, true, maximumInteger.error);
    assert.equal(BigInt(maximumInteger.value.value), (1n << 62n) - 1n);
    globalThis.crypto.getRandomValues = bytes => {
      bytes.fill(255);
      bytes[bytes.length - 1] = 254;
      return bytes;
    };
    const int64 = await dispatch(['9223372036854775807'], 'integer_number');
    assert.equal(int64.ok, true, int64.error);
    assert.equal(int64.value.value, '9223372036854775806');
    let attempts = 0;
    globalThis.crypto.getRandomValues = bytes => bytes.fill(attempts++ === 0 ? 255 : 2);
    const bounded = await dispatch([3]);
    assert.equal(bounded.ok, true, bounded.error);
    assert.equal(bounded.value.value, '2');
    assert.equal(attempts, 2);
    for (const limit of [null, '10', [1, 2]]) assert.equal((await dispatch([limit])).ok, false);
  } finally {
    globalThis.crypto.getRandomValues = original;
    runtime.destroy();
  }
});
