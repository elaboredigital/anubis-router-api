import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectDiagnostic } from '../src/diagnostics.js';

test('buildConnectDiagnostic separa falhas de autenticacao, rotas e credenciais', () => {
  const ok = buildConnectDiagnostic({ auth: true, modelCount: 2, routeCount: 3, connectionCount: 1, keyCount: 1, at: '2026-11-24T12:00:00.000Z' });
  assert.equal(ok.ok, true);
  assert.equal(ok.checkedAt, '2026-11-24T12:00:00.000Z');
  assert.equal(ok.checks.find(c => c.id === 'authentication').ok, true);
  assert.equal(ok.modelCount, 2);

  const broken = buildConnectDiagnostic({ auth: false, modelCount: 0, routeCount: 0, connectionCount: 0, keyCount: 0 });
  assert.equal(broken.ok, false);
  for (const id of ['gateway', 'authentication', 'models', 'routes', 'connections', 'keys']) {
    assert.equal(broken.checks.find(c => c.id === id)?.ok, id === 'gateway', `${id} deveria refletir o estado informado`);
  }
  assert.doesNotMatch(JSON.stringify(broken), /Bearer|senha|secret|hash|anubis_[A-Za-z0-9_-]{8,}/i);
});
