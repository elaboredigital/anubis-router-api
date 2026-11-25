// Persistência do painel (rotas, credencial do fornecedor e hashes das chaves de cliente).
// Com DATABASE_URL (produção), cada conjunto é uma linha JSONB na tabela anubis_store do Postgres;
// sem ela (uso local e testes), arquivos JSON em data/, como antes.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function openStore(root, databaseUrl = process.env.DATABASE_URL) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query('CREATE TABLE IF NOT EXISTS anubis_store (name TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    return {
      kind: 'postgres',
      async load(name, fallback) {
        const { rows } = await pool.query('SELECT value FROM anubis_store WHERE name = $1', [name]);
        return rows.length ? rows[0].value : fallback;
      },
      async save(name, value) {
        await pool.query('INSERT INTO anubis_store (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [name, JSON.stringify(value)]);
      },
      async size() {
        const { rows } = await pool.query('SELECT pg_total_relation_size($1::regclass)::bigint AS bytes', ['anubis_store']);
        const value = Number(rows?.[0]?.bytes);
        return Number.isSafeInteger(value) ? value : null;
      },
    };
  }
  const file = name => path.join(root, 'data', `${name}.json`);
  return {
    kind: 'arquivos',
    async load(name, fallback) {
      try { return JSON.parse(await readFile(file(name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
    },
    async save(name, value) {
      await mkdir(path.dirname(file(name)), { recursive: true });
      const tmp = `${file(name)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, file(name));
    },
  };
}
