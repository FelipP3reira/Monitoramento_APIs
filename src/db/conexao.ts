import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { config } from '../config.ts';

import type { Banco } from './tipos.ts';

// O driver devolve numeric como string para nao perder precisao; aqui todos os
// numeric sao contagens e percentuais pequenos, entao converter para number e seguro.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export function criarBanco(urlDeConexao = config.DATABASE_URL): Kysely<Banco> {
  return new Kysely<Banco>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: urlDeConexao, max: 10 }),
    }),
  });
}

export type BancoDeDados = Kysely<Banco>;
