import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';

/**
 * Quantas horas para tras a agregacao reescreve a cada passada. Nao e so para
 * limitar o trabalho: como o upsert refaz a hora inteira, uma janela maior que um
 * ciclo cura sozinha qualquer buraco deixado por um worker que caiu.
 */
const JANELA_DE_AGREGACAO_HORAS = 48;

export async function agregarHorasFechadas(
  db: BancoDeDados,
  janelaHoras = JANELA_DE_AGREGACAO_HORAS,
): Promise<number> {
  const consulta = sql`
    insert into agregados_hora (
      monitor_id, hora, total, sucessos, latencia_p50, latencia_p95, latencia_maxima
    )
    select
      monitor_id,
      date_trunc('hour', verificado_em) as hora,
      count(*)::int,
      count(*) filter (where sucesso)::int,
      (percentile_disc(0.5) within group (order by latencia_ms)
        filter (where latencia_ms is not null))::int,
      (percentile_disc(0.95) within group (order by latencia_ms)
        filter (where latencia_ms is not null))::int,
      max(latencia_ms)::int
    from resultados
    where verificado_em >= date_trunc('hour', now()) - make_interval(hours => ${janelaHoras})
      and verificado_em < date_trunc('hour', now())
    group by monitor_id, date_trunc('hour', verificado_em)
    on conflict (monitor_id, hora) do update set
      total = excluded.total,
      sucessos = excluded.sucessos,
      latencia_p50 = excluded.latencia_p50,
      latencia_p95 = excluded.latencia_p95,
      latencia_maxima = excluded.latencia_maxima
  `;

  const resultado = await consulta.execute(db);

  return Number(resultado.numAffectedRows ?? 0n);
}

/**
 * So apaga o historico cru; o agregado por hora fica. E por isso que o uptime de
 * 90 dias continua respondendo mesmo com a retencao em 30.
 */
export async function aplicarRetencao(db: BancoDeDados, dias: number): Promise<number> {
  const resultado = await db
    .deleteFrom('resultados')
    .where('verificado_em', '<', sql<Date>`now() - make_interval(days => ${dias})`)
    .executeTakeFirst();

  return Number(resultado.numDeletedRows);
}
