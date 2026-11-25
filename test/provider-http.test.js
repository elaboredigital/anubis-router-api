import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validBase, providerFetch } from '../src/provider-http.js';

test('conector genérico rejeita URLs inseguras e endereços internos', async () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://localhost', 'https://example.com:8443', 'https://example.com/?token=secret']) assert.equal(validBase(url), false);
  assert.equal(validBase('https://api.example.com/v1'), true);
  await assert.rejects(providerFetch('https://127.0.0.1/v1/models'), /privado ou reservado/);
});
