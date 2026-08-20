import { sql } from 'kysely';

import { criarBanco, type BancoDeDados } from '../../src/db/conexao.ts';
import { aplicarMigracoes } from '../../src/db/migrar.ts';

export async function prepararBanco(): Promise<BancoDeDados> {
  await aplicarMigracoes();
  return criarBanco();
}

export async function limparBanco(db: BancoDeDados): Promise<void> {
  // monitores em cascata leva resultados, incidentes, agregados e canais junto.
  await sql`truncate table monitores restart identity cascade`.execute(db);
}
