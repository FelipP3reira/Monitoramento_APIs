import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';
import { decifrar } from '../seguranca/cifra.ts';

import type { RegistroDeCanais } from './registro.ts';
import { FalhaDeEntrega, type Alerta, type EventoDeAlerta } from './tipos.ts';

const BASE_DO_BACKOFF_SEGUNDOS = 30;
const MAXIMO_DE_TENTATIVAS = 5;

export interface SaldoDaEntrega {
  enviados: number;
  adiados: number;
  desistidos: number;
}

/**
 * Cria uma linha pendente por canal ativo do monitor (mais os canais globais).
 *
 * A chave de idempotencia junta incidente, evento e canal, e a coluna e unica:
 * chamar isso duas vezes para o mesmo fechamento nao gera dois avisos. Somado ao
 * fato de que so a borda do incidente chama aqui, e isso que impede o alerta de
 * virar um e-mail a cada trinta segundos enquanto o alvo esta fora.
 */
export async function enfileirarAlertas(
  db: BancoDeDados,
  monitorId: string,
  incidenteId: string,
  evento: EventoDeAlerta,
): Promise<number> {
  const resultado = await sql`
    insert into alertas_enviados (incidente_id, canal_id, evento, chave_idempotencia)
    select
      ${incidenteId}::uuid,
      id,
      ${evento},
      ${incidenteId} || ':' || ${evento} || ':' || id
    from canais_alerta
    where ativo
      and (monitor_id = ${monitorId}::uuid or monitor_id is null)
    on conflict (chave_idempotencia) do nothing
  `.execute(db);

  return Number(resultado.numAffectedRows ?? 0n);
}

interface AlertaPendente {
  id: number;
  tentativas: number;
  evento: EventoDeAlerta;
  tipo: string;
  destino: string;
  segredo_cifrado: string | null;
  incidente_id: string;
  monitor_nome: string;
  monitor_url: string;
  motivo: string;
  detalhe: string | null;
  aberto_em: Date;
  fechado_em: Date | null;
}

function esperaAte(tentativas: number): number {
  return BASE_DO_BACKOFF_SEGUNDOS * 2 ** (tentativas - 1);
}

function montarAlerta(pendente: AlertaPendente): Alerta {
  const fim = pendente.fechado_em;

  return {
    evento: pendente.evento,
    incidenteId: pendente.incidente_id,
    monitorNome: pendente.monitor_nome,
    monitorUrl: pendente.monitor_url,
    motivo: pendente.motivo,
    detalhe: pendente.detalhe,
    abertoEm: pendente.aberto_em,
    fechadoEm: fim,
    duracaoSegundos:
      fim === null ? null : Math.round((fim.getTime() - pendente.aberto_em.getTime()) / 1000),
  };
}

/**
 * Reivindica os pendentes vencidos com o mesmo `skip locked` do agendador de
 * checks, entao dois processos entregando alerta ao mesmo tempo nao mandam o
 * mesmo aviso duas vezes.
 */
async function reivindicarPendentes(db: BancoDeDados, limite: number): Promise<AlertaPendente[]> {
  const consulta = sql<AlertaPendente>`
    with reivindicados as (
      update alertas_enviados
         set tentativas = tentativas + 1
       where id in (
         select id
           from alertas_enviados
          where situacao = 'pendente'
            and proxima_tentativa_em <= now()
          order by proxima_tentativa_em
          limit ${limite}
          for update skip locked
       )
      returning id, tentativas, evento, canal_id, incidente_id
    )
    select
      reivindicados.id,
      reivindicados.tentativas,
      reivindicados.evento,
      reivindicados.incidente_id,
      canais_alerta.tipo,
      canais_alerta.destino,
      canais_alerta.segredo_cifrado,
      monitores.nome as monitor_nome,
      monitores.url as monitor_url,
      incidentes.motivo,
      incidentes.detalhe,
      incidentes.aberto_em,
      incidentes.fechado_em
    from reivindicados
    join canais_alerta on canais_alerta.id = reivindicados.canal_id
    join incidentes on incidentes.id = reivindicados.incidente_id
    join monitores on monitores.id = incidentes.monitor_id
  `;

  return (await consulta.execute(db)).rows;
}

async function marcarEnviado(db: BancoDeDados, id: number): Promise<void> {
  await db
    .updateTable('alertas_enviados')
    .set({ situacao: 'enviado', enviado_em: sql<Date>`now()`, ultimo_erro: null })
    .where('id', '=', id)
    .execute();
}

async function marcarFalhou(db: BancoDeDados, id: number, erro: string): Promise<void> {
  await db
    .updateTable('alertas_enviados')
    .set({ situacao: 'falhou', ultimo_erro: erro })
    .where('id', '=', id)
    .execute();
}

async function adiar(
  db: BancoDeDados,
  id: number,
  tentativas: number,
  erro: string,
): Promise<void> {
  await db
    .updateTable('alertas_enviados')
    .set({
      ultimo_erro: erro,
      proxima_tentativa_em: sql<Date>`now() + make_interval(secs => ${esperaAte(tentativas)})`,
    })
    .where('id', '=', id)
    .execute();
}

export async function entregarPendentes(
  db: BancoDeDados,
  registro: RegistroDeCanais,
  limite = 20,
): Promise<SaldoDaEntrega> {
  const pendentes = await reivindicarPendentes(db, limite);
  const saldo: SaldoDaEntrega = { enviados: 0, adiados: 0, desistidos: 0 };

  for (const pendente of pendentes) {
    const canal = registro.buscar(pendente.tipo);

    if (canal === undefined) {
      await marcarFalhou(db, pendente.id, `nao existe canal do tipo ${pendente.tipo}`);
      saldo.desistidos += 1;
      continue;
    }

    try {
      const segredo = pendente.segredo_cifrado === null ? null : decifrar(pendente.segredo_cifrado);
      await canal.enviar(montarAlerta(pendente), pendente.destino, segredo);
      await marcarEnviado(db, pendente.id);
      saldo.enviados += 1;
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida';
      const permanente = erro instanceof FalhaDeEntrega && erro.permanente;

      if (permanente || pendente.tentativas >= MAXIMO_DE_TENTATIVAS) {
        await marcarFalhou(db, pendente.id, mensagem);
        saldo.desistidos += 1;
      } else {
        await adiar(db, pendente.id, pendente.tentativas, mensagem);
        saldo.adiados += 1;
      }
    }
  }

  return saldo;
}
