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
