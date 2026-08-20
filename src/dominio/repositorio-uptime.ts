import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';

import { porcentagemDeUptime } from './uptime.ts';

export interface ResumoDeUptime {
  desde: Date;
  ate: Date;
  total_de_checks: number;
  sucessos: number;
  uptime: number | null;
}

export interface PontoDaSerie {
  hora: Date;
  total: number;
  sucessos: number;
  uptime: number | null;
  latencia_p50: number | null;
  latencia_p95: number | null;
  latencia_maxima: number | null;
}

/**
 * O periodo e sempre um numero exato de baldes de uma hora, sendo o ultimo a hora
 * corrente ainda em andamento. As horas ja fechadas vem do agregado; so a hora
 * corrente e lida do historico cru.
 *
 * A divisao nao e otimizacao prematura: 90 dias de um monitor de 30 em 30
 * segundos sao uns 260 mil registros crus contra 2160 linhas de agregado.
 */
export async function resumoDeUptime(
  db: BancoDeDados,
  monitorId: string,
  horas: number,
): Promise<ResumoDeUptime> {
  const consulta = sql<{
    desde: Date;
    ate: Date;
    total_de_checks: number;
    sucessos: number;
  }>`
    with janela as (
      select
        date_trunc('hour', now()) - make_interval(hours => ${horas - 1}) as inicio,
        date_trunc('hour', now()) as hora_corrente
    ),
    fechadas as (
      select
        coalesce(sum(total), 0) as total,
        coalesce(sum(sucessos), 0) as sucessos
      from agregados_hora, janela
      where monitor_id = ${monitorId}
        and hora >= janela.inicio
        and hora < janela.hora_corrente
    ),
    corrente as (
      select
        count(*) as total,
        count(*) filter (where sucesso) as sucessos
      from resultados, janela
      where monitor_id = ${monitorId}
        and verificado_em >= janela.hora_corrente
    )
    select
      janela.inicio as desde,
      now() as ate,
      (fechadas.total + corrente.total)::int as total_de_checks,
      (fechadas.sucessos + corrente.sucessos)::int as sucessos
    from janela, fechadas, corrente
  `;

  const linha = (await consulta.execute(db)).rows[0];
  if (linha === undefined) {
    throw new Error('A consulta de uptime nao devolveu linha.');
  }

  return {
    ...linha,
    uptime: porcentagemDeUptime(linha.total_de_checks, linha.sucessos),
  };
}

export async function serieHoraria(
  db: BancoDeDados,
  monitorId: string,
  horas: number,
): Promise<PontoDaSerie[]> {
  const consulta = sql<{
    hora: Date;
    total: number;
    sucessos: number;
    latencia_p50: number | null;
    latencia_p95: number | null;
    latencia_maxima: number | null;
  }>`
    with janela as (
      select
        date_trunc('hour', now()) - make_interval(hours => ${horas - 1}) as inicio,
        date_trunc('hour', now()) as hora_corrente
    )
    select hora, total, sucessos, latencia_p50, latencia_p95, latencia_maxima
    from agregados_hora, janela
    where monitor_id = ${monitorId}
      and hora >= janela.inicio
      and hora < janela.hora_corrente

    union all

    select
      janela.hora_corrente as hora,
      count(*)::int as total,
      count(*) filter (where sucesso)::int as sucessos,
      (percentile_disc(0.5) within group (order by latencia_ms))::int as latencia_p50,
      (percentile_disc(0.95) within group (order by latencia_ms))::int as latencia_p95,
      max(latencia_ms)::int as latencia_maxima
    from resultados, janela
    where monitor_id = ${monitorId}
      and verificado_em >= janela.hora_corrente
    group by janela.hora_corrente
    having count(*) > 0

    order by hora
  `;

  const { rows } = await consulta.execute(db);

  return rows.map((ponto) => ({
    ...ponto,
    uptime: porcentagemDeUptime(ponto.total, ponto.sucessos),
  }));
}
