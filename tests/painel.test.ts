import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BancoDeDados } from '../src/db/conexao.ts';
import { montarPainel } from '../src/dominio/repositorio-painel.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';

let db: BancoDeDados;

beforeAll(async () => {
  db = await prepararBanco();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await limparBanco(db);
});

async function criarMonitor(nome: string, ativo = true): Promise<string> {
  const linha = await db
    .insertInto('monitores')
    .values({
      nome,
      url: 'https://exemplo.com/saude',
      intervalo_segundos: 60,
      assertivas: JSON.stringify([]),
      ativo,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return linha.id;
}

async function gravar(monitorId: string, sucesso: boolean, segundosAtras = 5): Promise<void> {
  await db
    .insertInto('resultados')
    .values({
      monitor_id: monitorId,
      sucesso,
      codigo_http: sucesso ? 200 : 503,
      latencia_ms: sucesso ? 42 : 900,
      motivo_falha: sucesso ? null : 'status',
      detalhe: sucesso ? null : 'respondeu 503',
      verificado_em: sql<Date>`now() - make_interval(secs => ${segundosAtras})`,
    })
    .execute();
}

describe('painel', () => {
  it('marca sem dados quando o monitor nunca foi checado', async () => {
    await criarMonitor('novinho');

    const [linha] = await montarPainel(db);

    expect(linha).toMatchObject({
      situacao: 'sem_dados',
      ultimo_check: null,
      uptime_24h: null,
    });
  });

  it('marca desligado antes de olhar qualquer historico', async () => {
    const id = await criarMonitor('parado', false);
    await gravar(id, false);

    const [linha] = await montarPainel(db);

    expect(linha?.situacao).toBe('desligado');
  });

  it('marca no ar quando o ultimo check passou', async () => {
    const id = await criarMonitor('saudavel');
    await gravar(id, true);

    const [linha] = await montarPainel(db);

    expect(linha).toMatchObject({ situacao: 'no_ar', ultima_latencia_ms: 42, uptime_24h: 100 });
  });

  it('marca instavel quando falhou agora mas ainda nao virou incidente', async () => {
    const id = await criarMonitor('oscilando');
    await gravar(id, true, 30);
    await gravar(id, false, 5);

    const [linha] = await montarPainel(db);

    expect(linha).toMatchObject({
      situacao: 'instavel',
      ultimo_motivo: 'status',
      incidente_desde: null,
      uptime_24h: 50,
    });
  });

  it('marca fora do ar quando existe incidente aberto', async () => {
    const id = await criarMonitor('caido');
    await gravar(id, false);
    await db
      .insertInto('incidentes')
      .values({ monitor_id: id, motivo: 'status', falhas: 3 })
      .execute();

    const [linha] = await montarPainel(db);

    expect(linha?.situacao).toBe('fora_do_ar');
    expect(linha?.incidente_desde).not.toBeNull();
  });

  it('ignora incidente ja fechado ao classificar', async () => {
    const id = await criarMonitor('recuperado');
    await gravar(id, true);
    await db
      .insertInto('incidentes')
      .values({
        monitor_id: id,
        motivo: 'status',
        falhas: 3,
        fechado_em: sql<Date>`now()`,
      })
      .execute();

    const [linha] = await montarPainel(db);

    expect(linha).toMatchObject({ situacao: 'no_ar', incidente_desde: null });
  });

  it('devolve os monitores em ordem de nome, sem misturar historico', async () => {
    const primeiro = await criarMonitor('alfa');
    const segundo = await criarMonitor('beta');
    await gravar(primeiro, true);
    await gravar(segundo, false);
    await gravar(segundo, false);

    const painel = await montarPainel(db);

    expect(painel.map((linha) => linha.nome)).toEqual(['alfa', 'beta']);
    expect(painel[0]?.uptime_24h).toBe(100);
    expect(painel[1]?.uptime_24h).toBe(0);
  });
});
