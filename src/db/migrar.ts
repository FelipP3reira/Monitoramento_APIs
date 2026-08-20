import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import { config } from '../config.ts';

const PASTA_DAS_MIGRACOES = join(import.meta.dirname, 'migracoes');

export async function aplicarMigracoes(urlDeConexao = config.DATABASE_URL): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: urlDeConexao, max: 1 });
  const aplicadas: string[] = [];

  try {
    await pool.query(`
      create table if not exists migracoes_aplicadas (
        nome text primary key,
        aplicada_em timestamptz not null default now()
      )
    `);

    const jaAplicadas = await pool.query<{ nome: string }>('select nome from migracoes_aplicadas');
    const conhecidas = new Set(jaAplicadas.rows.map((linha) => linha.nome));

    const arquivos = (await readdir(PASTA_DAS_MIGRACOES))
      .filter((arquivo) => arquivo.endsWith('.sql'))
      .sort();

    for (const arquivo of arquivos) {
      if (conhecidas.has(arquivo)) continue;

      const sql = await readFile(join(PASTA_DAS_MIGRACOES, arquivo), 'utf8');
      const conexao = await pool.connect();

      try {
        await conexao.query('begin');
        await conexao.query(sql);
        await conexao.query('insert into migracoes_aplicadas (nome) values ($1)', [arquivo]);
        await conexao.query('commit');
        aplicadas.push(arquivo);
      } catch (erro) {
        await conexao.query('rollback');
        throw new Error(`Migracao ${arquivo} falhou: ${(erro as Error).message}`, { cause: erro });
      } finally {
        conexao.release();
      }
    }
  } finally {
    await pool.end();
  }

  return aplicadas;
}

if (process.argv[1] === import.meta.filename) {
  const aplicadas = await aplicarMigracoes();
  console.log(
    aplicadas.length === 0
      ? 'Banco ja estava atualizado.'
      : `Migracoes aplicadas: ${aplicadas.join(', ')}`,
  );
}
