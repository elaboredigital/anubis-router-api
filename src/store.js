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

/**
 * Lançamentos que não podem se perder (razão financeira, recargas e pedidos de recarga): uma linha por item.
 * Cada processo grava só o item que mudou, então dois processos ao mesmo tempo (ex.: durante um redeploy) não apagam
 * o trabalho um do outro. `changedSince` permite reler o que outro processo gravou.
 * Com DATABASE_URL: tabela anubis_entries no Postgres. Sem ela: um arquivo JSONL por tipo em data/ (última versão vence).
 */
export async function openEntries(root, databaseUrl = process.env.DATABASE_URL) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query(`CREATE TABLE IF NOT EXISTS anubis_entries (
      kind TEXT NOT NULL, id TEXT NOT NULL, value JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (kind, id))`);
    await pool.query('CREATE INDEX IF NOT EXISTS anubis_entries_updated_idx ON anubis_entries (kind, updated_at)');
    return {
      kind: 'postgres',
      async list(kind) {
        const { rows } = await pool.query('SELECT value FROM anubis_entries WHERE kind = $1 ORDER BY created_at, id', [kind]);
        return rows.map(row => row.value);
      },
      async upsert(kind, item) {
        await pool.query(`INSERT INTO anubis_entries (kind, id, value) VALUES ($1, $2, $3)
          ON CONFLICT (kind, id) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`, [kind, String(item.id), JSON.stringify(item)]);
      },
      async upsertMany(kind, items) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const item of items) await client.query(`INSERT INTO anubis_entries (kind, id, value) VALUES ($1, $2, $3)
            ON CONFLICT (kind, id) DO NOTHING`, [kind, String(item.id), JSON.stringify(item)]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      },
      /** Itens alterados depois de `since` (ISO), com o maior updated_at visto para a próxima consulta. */
      async changedSince(kind, since) {
        const { rows } = await pool.query('SELECT value, updated_at FROM anubis_entries WHERE kind = $1 AND updated_at > $2 ORDER BY updated_at', [kind, since]);
        return { items: rows.map(row => row.value), cursor: rows.length ? new Date(rows.at(-1).updated_at).toISOString() : since };
      },
      async now() { const { rows } = await pool.query('SELECT clock_timestamp() AS now'); return new Date(rows[0].now).toISOString(); },
    };
  }
  const file = kind => path.join(root, 'data', `entries-${kind}.jsonl`);
  let writes = Promise.resolve();
  const append = (kind, items) => {
    const task = writes.then(async () => {
      await mkdir(path.dirname(file(kind)), { recursive: true });
      const { appendFile } = await import('node:fs/promises');
      await appendFile(file(kind), items.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    });
    writes = task.catch(() => {}); return task;
  };
  return {
    kind: 'arquivos',
    async list(kind) {
      await writes; let text;
      try { text = await readFile(file(kind), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const items = new Map();
      for (const line of text.split('\n')) if (line) { const item = JSON.parse(line); items.set(String(item.id), item); }
      return [...items.values()];
    },
    upsert(kind, item) { return append(kind, [item]); },
    async upsertMany(kind, items) { if (items.length) await append(kind, items); },
    // Um único processo usa os arquivos locais: não há o que reler.
    async changedSince(_kind, since) { return { items: [], cursor: since }; },
    async now() { return new Date().toISOString(); },
  };
}
