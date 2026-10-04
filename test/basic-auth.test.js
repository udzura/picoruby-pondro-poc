import assert from 'node:assert/strict';
import test from 'node:test';
import { timingSafeEqual } from 'node:crypto';
import { authenticate } from '../worker/basic-auth.js';

// Provide Workers' Web Crypto extension when running these tests in Node.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const env = { BASIC_AUTH_USER: 'demo', BASIC_AUTH_PASSWORD: '秘密:password' };
const authorization = value => `Basic ${Buffer.from(value).toString('base64')}`;
const request = header => new Request('https://example.test/', { headers: header ? { Authorization: header } : {} });

test('Basic auth accepts UTF-8 credentials and passwords containing colons', async () => {
  assert.equal(await authenticate(request(authorization('demo:秘密:password')), env), null);
});

test('Basic auth challenges missing, incorrect and malformed credentials', async () => {
  for (const header of [undefined, 'Bearer token', 'Basic !!!', 'Basic a', authorization('wrong:秘密:password'), authorization('demo:wrong')]) {
    const response = await authenticate(request(header), env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('WWW-Authenticate'), /^Basic .*charset="UTF-8"/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('Basic auth fails closed when secrets are missing or invalid', async () => {
  for (const config of [{}, { BASIC_AUTH_USER: 'demo' }, { ...env, BASIC_AUTH_PASSWORD: '' }, { ...env, BASIC_AUTH_USER: 'bad:user' }]) {
    assert.equal((await authenticate(request(authorization('demo:秘密:password')), config)).status, 503);
  }
});
