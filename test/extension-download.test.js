import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function startGateway(dir) {
  await cp('src', path.join(dir, 'src'), { recursive: true });
  await cp('../public', path.join(dir, 'public'), { recursive: true });
  await cp('package.json', path.join(dir, 'package.json'));
  await mkdir(path.join(dir, 'extension'), { recursive: true });
  await cp('../extension/package.json', path.join(dir, 'extension', 'package.json'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const adminKey = 'admin-key-1234567890123';
  const child = spawn(process.execPath, [path.join(dir, 'src/server.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ANUBIS_ADMIN_KEY: adminKey, ANUBIS_ENCRYPTION_KEY: 'ab'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', code => reject(new Error(`servidor encerrou com ${code}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    adminKey,
    async stop() {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    },
  };
}

test('painel oferece o VSIX somente com a chave administrativa', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anubis-extension-test-'));
  const gateway = await startGateway(dir);
  t.after(async () => { await gateway.stop(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${gateway.adminKey}` };
  // A versão exibida vem do manifesto, então o teste acompanha cada aumento de versão.
  const manifest = JSON.parse(await readFile(path.join('..', 'extension', 'package.json'), 'utf8'));
  const version = manifest.version;
  const file = `anubis-router-vscode-${version}.vsix`;

  assert.equal((await fetch(`${gateway.base}/admin/extension`)).status, 401);
  assert.equal((await fetch(`${gateway.base}/admin/extension/info`)).status, 401);

  const missingInfo = await fetch(`${gateway.base}/admin/extension/info`, { headers });
  const missingBody = await missingInfo.json();
  assert.equal(missingBody.version, version);
  assert.equal(missingBody.file, file);
  assert.equal(missingBody.available, false);
  assert.deepEqual(missingBody.targets.map(target => target.id), ['vscode', 'cursor', 'windsurf', 'vscodium']);
  assert.equal(missingBody.targets.find(target => target.id === 'cursor').install, `cursor --install-extension ${file}`);

  const missing = await fetch(`${gateway.base}/admin/extension`, { headers });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /extens|vsix|dispon/i);

  await mkdir(path.join(dir, 'extension'), { recursive: true });
  const artifact = Buffer.from('PK\x03\x04conteudo-simulado-do-vsix');
  await writeFile(path.join(dir, 'extension', file), artifact);

  assert.equal((await (await fetch(`${gateway.base}/admin/extension/info`, { headers })).json()).available, true);

  const response = await fetch(`${gateway.base}/admin/extension`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-anubis-extension-version'), version);
  assert.match(response.headers.get('content-type'), /application\/(octet-stream|vsix)/);
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${file}"`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), artifact);

  // A chave não pode viajar na URL, e a rota não serve outros arquivos.
  assert.equal((await fetch(`${gateway.base}/admin/extension?key=${gateway.adminKey}`)).status, 401);
  assert.equal((await fetch(`${gateway.base}/admin/extension/%2e%2e%2fserver.js`, { headers })).status, 404);
});
