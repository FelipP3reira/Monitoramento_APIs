import type { ResultadoDoCheck } from '../checagem/executor.ts';
import type { BancoDeDados } from '../db/conexao.ts';

export async function gravarResultado(
  db: BancoDeDados,
  monitorId: string,
  resultado: ResultadoDoCheck,
): Promise<void> {
  await db
    .insertInto('resultados')
    .values({
      monitor_id: monitorId,
      sucesso: resultado.sucesso,
      codigo_http: resultado.codigo_http,
      latencia_ms: resultado.latencia_ms,
      motivo_falha: resultado.motivo_falha,
      detalhe: resultado.detalhe,
    })
    .execute();
}

export async function ultimosResultados(
  db: BancoDeDados,
  monitorId: string,
  limite: number,
): Promise<{ sucesso: boolean }[]> {
  return db
    .selectFrom('resultados')
    .select('sucesso')
    .where('monitor_id', '=', monitorId)
    .orderBy('verificado_em', 'desc')
    .orderBy('id', 'desc')
    .limit(limite)
    .execute();
}
