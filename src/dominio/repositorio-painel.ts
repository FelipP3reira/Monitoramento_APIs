import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';

import { porcentagemDeUptime } from './uptime.ts';

export type SituacaoDoMonitor = 'no_ar' | 'instavel' | 'fora_do_ar' | 'sem_dados' | 'desligado';

export interface LinhaDoPainel {
  id: string;
  nome: string;
  url: string;
  ativo: boolean;
  situacao: SituacaoDoMonitor;
  ultimo_check: Date | null;
  ultima_latencia_ms: number | null;
  ultimo_motivo: string | null;
  incidente_desde: Date | null;
  uptime_24h: number | null;
}

interface LinhaBruta {
  id: string;
  nome: string;
  url: string;
  ativo: boolean;
  ultimo_check: Date | null;
  ultimo_sucesso: boolean | null;
  ultima_latencia_ms: number | null;
  ultimo_motivo: string | null;
  incidente_desde: Date | null;
  total_24h: number;
  sucessos_24h: number;
}

function classificar(linha: LinhaBruta): SituacaoDoMonitor {
  if (!linha.ativo) return 'desligado';
  if (linha.incidente_desde !== null) return 'fora_do_ar';
  if (linha.ultimo_sucesso === null) return 'sem_dados';
  // Falhou agora mas ainda nao acumulou o bastante para virar incidente.
  return linha.ultimo_sucesso ? 'no_ar' : 'instavel';
}

/**
 * Uma consulta para o painel inteiro. Deixar o navegador pedir uptime e ultimo
 * resultado monitor a monitor daria uma tela que faz dezenas de chamadas para
 * mostrar uma lista.
 */
export async function montarPainel(db: BancoDeDados): Promise<LinhaDoPainel[]> {
  const consulta = sql<LinhaBruta>`
    with corte as (
      select
        date_trunc('hour', now()) as hora_corrente,
        date_trunc('hour', now()) - interval '23 hours' as inicio
    )
    select
      monitores.id,
      monitores.nome,
      monitores.url,
      monitores.ativo,
      ultimo.verificado_em as ultimo_check,
      ultimo.sucesso as ultimo_sucesso,
      ultimo.latencia_ms as ultima_latencia_ms,
      ultimo.motivo_falha as ultimo_motivo,
      incidentes.aberto_em as incidente_desde,
      (
        coalesce(fechadas.total, 0) + coalesce(corrente.total, 0)
      )::int as total_24h,
      (
        coalesce(fechadas.sucessos, 0) + coalesce(corrente.sucessos, 0)
      )::int as sucessos_24h
    from monitores
    cross join corte
    left join lateral (
      select verificado_em, sucesso, latencia_ms, motivo_falha
      from resultados
      where resultados.monitor_id = monitores.id
      order by verificado_em desc
      limit 1
    ) as ultimo on true
    left join incidentes
      on incidentes.monitor_id = monitores.id
      and incidentes.fechado_em is null
    left join lateral (
      select sum(total) as total, sum(sucessos) as sucessos
      from agregados_hora
      where agregados_hora.monitor_id = monitores.id
        and hora >= corte.inicio
        and hora < corte.hora_corrente
    ) as fechadas on true
    left join lateral (
      select count(*) as total, count(*) filter (where sucesso) as sucessos
      from resultados
      where resultados.monitor_id = monitores.id
        and verificado_em >= corte.hora_corrente
    ) as corrente on true
    order by monitores.nome
  `;

  const { rows } = await consulta.execute(db);

  return rows.map((linha) => ({
    id: linha.id,
    nome: linha.nome,
    url: linha.url,
    ativo: linha.ativo,
    situacao: classificar(linha),
    ultimo_check: linha.ultimo_check,
    ultima_latencia_ms: linha.ultima_latencia_ms,
    ultimo_motivo: linha.ultimo_motivo,
    incidente_desde: linha.incidente_desde,
    uptime_24h: porcentagemDeUptime(linha.total_24h, linha.sucessos_24h),
  }));
}
