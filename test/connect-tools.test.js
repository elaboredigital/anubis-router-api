import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tools = JSON.parse(await readFile(new URL('../../admin/connect-tools.json', import.meta.url), 'utf8'));

test('catálogo de ferramentas traz status honesto e exemplos sem segredo', () => {
  const allowed = new Set(['planejado', 'em homologação', 'disponível']);
  assert.ok(tools.length >= 6);
  for (const tool of tools) {
    assert.match(tool.id, /^[a-z0-9-]+$/);
    assert.ok(tool.name && tool.category && tool.summary && tool.limits);
    assert.ok(allowed.has(tool.status), `${tool.id}: status inválido`);
    assert.match(tool.docs, /^https:\/\//);
    assert.ok(Array.isArray(tool.steps) && tool.steps.length >= 2);
    assert.ok(tool.snippets && Object.keys(tool.snippets).length >= 1);
  }
  const n8n = tools.find(tool => tool.id === 'n8n');
  assert.equal(n8n.status, 'em homologação');
  assert.match(n8n.limits, /não foi publicado|não testado/);
  const ids = tools.map(tool => tool.id);
  for (const id of ['vscode-windsurf', 'claude-code', 'codex', 'cursor', 'n8n', 'sdk-http']) assert.ok(ids.includes(id), `falta ${id}`);
  const text = JSON.stringify(tools);
  assert.match(text, /<SUA_CHAVE_ANUBIS>/);
  assert.equal(/anubis_[A-Za-z0-9_-]{8,}/.test(text), false);
});
