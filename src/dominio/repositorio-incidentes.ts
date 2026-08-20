import { sql } from 'kysely';

import type { ResultadoDoCheck } from '../checagem/executor.ts';
import type { BancoDeDados } from '../db/conexao.ts';

export interface IncidenteAberto {
  id: string;
  aberto_em: Date;
  motivo: string;
  falhas: number;
}

export interface IncidenteRegistrado extends IncidenteAberto {
  fechado_em: Date | null;
  detalhe: string | null;
}

export async function buscarIncidenteAberto(
  db: BancoDeDados,
  monitorId: string,
): Promise<IncidenteAberto | undefined> {
  return db
    .selectFrom('incidentes')
    .select(['id', 'aberto_em', 'motivo', 'falhas'])
    .where('monitor_id', '=', monitorId)
    .where('fechado_em', 'is', null)
    .executeTakeFirst();
}

/**
 * O `on conflict do nothing` aponta para o indice unico parcial de incidente
 * aberto. Se dois caminhos tentarem abrir ao mesmo tempo, o banco decide quem
 * ganha e o perdedor recebe undefined em vez de estourar.
 */
export async function abrirIncidente(
  db: BancoDeDados,
  monitorId: string,
  resultado: ResultadoDoCheck,
  falhasIniciais: number,
): Promise<string | undefined> {
  const aberto = await db
    .insertInto('incidentes')
    .values({
      monitor_id: monitorId,
      motivo: resultado.motivo_falha ?? 'conexao',
      detalhe: resultado.detalhe,
      falhas: falhasIniciais,
    })
    .onConflict((conflito) =>
      conflito.columns(['monitor_id']).where('fechado_em', 'is', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  return aberto?.id;
}

export async function fecharIncidente(
  db: BancoDeDados,
  monitorId: string,
): Promise<string | undefined> {
  const fechado = await db
    .updateTable('incidentes')
    .set({ fechado_em: sql<Date>`now()` })
    .where('monitor_id', '=', monitorId)
    .where('fechado_em', 'is', null)
    .returning('id')
    .executeTakeFirst();

  return fechado?.id;
}

export async function contarMaisUmaFalha(db: BancoDeDados, monitorId: string): Promise<void> {
  await db
    .updateTable('incidentes')
    .set((construtor) => ({ falhas: sql<number>`${construtor.ref('falhas')} + 1` }))
    .where('monitor_id', '=', monitorId)
    .where('fechado_em', 'is', null)
    .execute();
}

export async function listarIncidentes(
  db: BancoDeDados,
  monitorId: string,
  limite: number,
): Promise<IncidenteRegistrado[]> {
  return db
    .selectFrom('incidentes')
    .select(['id', 'aberto_em', 'fechado_em', 'motivo', 'detalhe', 'falhas'])
    .where('monitor_id', '=', monitorId)
    .orderBy('aberto_em', 'desc')
    .limit(limite)
    .execute();
}
