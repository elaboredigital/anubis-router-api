// npm run dev — sobe o Anubis local.
// Com DATABASE_URL apontando para o banco do Coolify (host interno, ex.: ntx93v6kf3ax8lu84tgpynnb) e TUNNEL_SSH_* no .env,
// abre um túnel SSH até a SeasonCloud e usa o banco de PRODUÇÃO por 127.0.0.1:15440 (o banco não tem porta pública).
// Sem DATABASE_URL, os dados ficam em data/ (arquivos locais).
//
//   TUNNEL_SSH_HOST=45.154.159.48  TUNNEL_SSH_PORT=22  TUNNEL_SSH_USER=root  TUNNEL_SSH_PASS=...
import net from 'node:net';
import { existsSync } from 'node:fs';

const LOCAL_PORT = 15440;
if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
env.HOST = '127.0.0.1'; // local: o painel não fica exposto na rede

const remote = env.DATABASE_URL && !/^(localhost|127\.0\.0\.1)$/.test(new URL(env.DATABASE_URL).hostname);
if (remote) {
  if (!env.TUNNEL_SSH_HOST || !env.TUNNEL_SSH_PASS) {
    console.error('[túnel] DATABASE_URL aponta para o banco do Coolify, que não tem porta pública. Preencha TUNNEL_SSH_HOST e TUNNEL_SSH_PASS no .env (ou apague DATABASE_URL para usar arquivos em data/).');
    process.exit(1);
  }
  const { Client } = await import('ssh2');
  let ssh = null, connecting = null;
  const connect = () => connecting ??= new Promise((ok, fail) => {
    const c = new Client();
    c.on('ready', () => { ssh = c; ok(c); })
      .on('error', e => { connecting = null; fail(e); })
      .on('close', () => { if (ssh === c) ssh = null; connecting = null; })
      .connect({ host: env.TUNNEL_SSH_HOST, port: Number(env.TUNNEL_SSH_PORT || 22), username: env.TUNNEL_SSH_USER || 'root',
        password: env.TUNNEL_SSH_PASS, keepaliveInterval: 10_000, keepaliveCountMax: 6, readyTimeout: 30_000 });
  });
  const containerIp = (c, name) => new Promise((ok, fail) => {
    c.exec(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${name}`, (e, s) => {
      if (e) return fail(e);
      let out = '';
      s.on('data', d => { out += d; }).on('close', () => {
        const ip = out.trim().split(/\s+/)[0];
        ip ? ok(ip) : fail(new Error(`container ${name} não encontrado`));
      });
    });
  });

  const url = new URL(env.DATABASE_URL), container = url.hostname, target = Number(url.port || 5432);
  const ip = await containerIp(await connect().catch(e => {
    console.error(`[túnel] não conectou em ${env.TUNNEL_SSH_HOST}: ${e.message}. Confira TUNNEL_SSH_USER e TUNNEL_SSH_PASS no .env.`);
    process.exit(1);
  }), container);
  const server = net.createServer(async local => {
    local.pause();
    try {
      const c = ssh ?? await connect();
      const addr = await containerIp(c, container);
      c.forwardOut('127.0.0.1', LOCAL_PORT, addr, target, (e, remoteStream) => {
        if (e) { console.error(`[túnel] ${e.message}`); return local.destroy(); }
        local.pipe(remoteStream).pipe(local); local.resume();
        local.on('error', () => remoteStream.destroy()); remoteStream.on('error', () => local.destroy());
      });
    } catch (e) { console.error(`[túnel] ${e.message}`); local.destroy(); }
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(LOCAL_PORT, '127.0.0.1', ok));
  console.log(`[túnel] banco de PRODUÇÃO: 127.0.0.1:${LOCAL_PORT} → ${env.TUNNEL_SSH_HOST} → ${container} (${ip}:${target})`);
  url.hostname = '127.0.0.1'; url.port = String(LOCAL_PORT);
  env.DATABASE_URL = url.href;
}

await import('../src/server.js');
