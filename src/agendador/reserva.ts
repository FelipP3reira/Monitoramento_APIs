import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';
import type { MetodoHttp } from '../db/tipos.ts';
import type { Assertiva } from '../dominio/assertivas.ts';

export interface MonitorReservado {
  id: string;
  url: string;
  metodo: MetodoHttp;
  cabecalhos_cifrados: string | null;
  corpo: string | null;
  timeout_ms: number;
  status_esperado: number[];
  latencia_maxima_ms: number | null;
  assertivas: Assertiva[];
  intervalo_segundos: number;
  falhas_para_abrir: number;
  sucessos_para_fechar: number;
}

/**
 * Reserva um lote de monitores vencidos para este worker.
 *
 * O `for update skip locked` e o que permite ligar varios workers sem
 * coordenacao externa: quem chegar depois pula as linhas ja travadas em vez de
 * ficar esperando, entao ninguem checa o mesmo monitor duas vezes e ninguem fica
 * parado atras de outro.
 *
 * O `reservado_ate` cobre o outro lado: se o worker morrer no meio do check, a
 * reserva vence sozinha e o monitor volta para a fila no proximo ciclo, sem
 * precisar de rotina de limpeza.
 */
export async function reservarMonitores(
  db: BancoDeDados,
  lote: number,
  leaseSegundos: number,
): Promise<MonitorReservado[]> {
  const vencidos = db
    .selectFrom('monitores')
    .select('id')
    .where('ativo', '=', true)
    .where('proximo_check_em', '<=', sql<Date>`now()`)
    .where((construtor) =>
      construtor.or([
        construtor('reservado_ate', 'is', null),
        construtor('reservado_ate', '<', sql<Date>`now()`),
      ]),
    )
    .orderBy('proximo_check_em')
    .limit(lote)
    .forUpdate()
    .skipLocked();

  const reservados = await db
    .updateTable('monitores')
    .set({ reservado_ate: sql<Date>`now() + make_interval(secs => ${leaseSegundos})` })
    .where('id', 'in', vencidos)
    .returning([
      'id',
      'url',
      'metodo',
      'cabecalhos_cifrados',
      'corpo',
      'timeout_ms',
      'status_esperado',
      'latencia_maxima_ms',
      'assertivas',
      'intervalo_segundos',
      'falhas_para_abrir',
      'sucessos_para_fechar',
    ])
    .execute();

  return reservados;
}

/**
 * O proximo check parte de agora, e nao do horario que estava agendado: depois de
 * uma parada longa, somar ao horario antigo faria o worker disparar de uma vez
 * todos os checks que ficaram para tras.
 */
export async function liberarMonitor(
  db: BancoDeDados,
  id: string,
  intervaloSegundos: number,
): Promise<void> {
  await db
    .updateTable('monitores')
    .set({
      reservado_ate: null,
      proximo_check_em: sql<Date>`now() + make_interval(secs => ${intervaloSegundos})`,
    })
    .where('id', '=', id)
    .execute();
}
