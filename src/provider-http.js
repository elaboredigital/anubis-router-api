import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked.addSubnet(address, prefix, 'ipv6');
export function validBase(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === '443') && u.hostname !== 'localhost' && !u.hostname.endsWith('.localhost'); } catch { return false; }
}
export async function providerFetch(url, options = {}) {
  // Apenas testes podem redirecionar o perfil xKiro para o servidor simulado.
  if (process.env.NODE_ENV === 'test' && process.env.TEST_UPSTREAM_URL && url.startsWith(process.env.TEST_UPSTREAM_URL)) return fetch(url, options);
  if (!validBase(new URL(url).origin)) throw new Error('Endereço do fornecedor inválido');
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => (a.family === 6 && a.address.toLowerCase().startsWith('::ffff:')) || blocked.check(a.address, a.family === 4 ? 'ipv4' : 'ipv6'))) throw new Error('Endereço privado ou reservado não permitido');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method: options.method || 'GET', headers: options.headers, signal: options.signal, lookup: (_host, opts, cb) => opts.all ? cb(null, [address]) : cb(null, address.address, address.family) }, res => {
      const headers = new Headers(); for (const [k,v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  });
}
