import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agregarHorasFechadas, aplicarRetencao } from '../src/agendador/manutencao.ts';
import type { BancoDeDados } from '../src/db/conexao.ts';
import { resumoDeUptime, serieHoraria } from '../src/dominio/repositorio-uptime.ts';
import { porcentagemDeUptime } from '../src/dominio/uptime.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';

describe('porcentagem de uptime', () => {
  it('devolve nulo quando nao houve check nenhum', () => {
    expect(porcentagemDeUptime(0, 0)).toBeNull();
  });

  it('calcula com duas casas', () => {
    expect(porcentagemDeUptime(1000, 997)).toBe(99.7);
    expect(porcentagemDeUptime(3, 2)).toBe(66.66);
    expect(porcentagemDeUptime(120, 120)).toBe(100);
    expect(porcentagemDeUptime(120, 0)).toBe(0);
  });

  it('so devolve 100 quando nao houve nenhuma falha', () => {
    // Arredondar deixaria 99,996 virar 100 e sumir com quatro falhas reais.
    expect(porcentagemDeUptime(100_000, 99_996)).toBe(99.99);
    expect(porcentagemDeUptime(100_000, 100_000)).toBe(100);
    expect(porcentagemDeUptime(10_000, 9_999)).toBe(99.99);
  });
});

describe('uptime no banco', () => {
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

  async function criarMonitor(): Promise<string> {
    const linha = await db
      .insertInto('monitores')
      .values({
        nome: 'alvo',
        url: 'https://exemplo.com/saude',
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return linha.id;
  }

  /** Grava um check numa hora relativa a agora, para montar historico sintetico. */
  async function gravarEm(
    monitorId: string,
    horasAtras: number,
    sucesso: boolean,
    latencia: number,
  ): Promise<void> {
    await db
      .insertInto('resultados')
      .values({
        monitor_id: monitorId,
        sucesso,
        codigo_http: sucesso ? 200 : 500,
        latencia_ms: latencia,
        motivo_falha: sucesso ? null : 'status',
        detalhe: sucesso ? null : 'respondeu 500',
        verificado_em: sql<Date>`date_trunc('hour', now()) - make_interval(hours => ${horasAtras}) + interval '5 minutes'`,
      })
      .execute();
  }

  it('devolve nulo, e nao 100, para monitor sem nenhum check', async () => {
    const id = await criarMonitor();

    const resumo = await resumoDeUptime(db, id, 24);

    expect(resumo).toMatchObject({ total_de_checks: 0, sucessos: 0, uptime: null });
  });

  it('conta a hora corrente direto do historico cru', async () => {
    const id = await criarMonitor();
    await gravarEm(id, 0, true, 40);
    await gravarEm(id, 0, true, 42);
    await gravarEm(id, 0, false, 900);

    const resumo = await resumoDeUptime(db, id, 24);

    expect(resumo).toMatchObject({ total_de_checks: 3, sucessos: 2, uptime: 66.66 });
  });

  it('soma as horas fechadas do agregado com a hora corrente', async () => {
    const id = await criarMonitor();
    for (let vez = 0; vez < 10; vez += 1) await gravarEm(id, 3, true, 50);
    await gravarEm(id, 3, false, 800);
    await gravarEm(id, 0, true, 45);

    await agregarHorasFechadas(db);

    const resumo = await resumoDeUptime(db, id, 24);

    expect(resumo).toMatchObject({ total_de_checks: 12, sucessos: 11 });
    expect(resumo.uptime).toBeCloseTo(91.66, 2);
  });

  it('ignora o que ficou fora da janela pedida', async () => {
    const id = await criarMonitor();
    await gravarEm(id, 30, false, 900);
    await gravarEm(id, 2, true, 50);
    await agregarHorasFechadas(db);

    const janelaCurta = await resumoDeUptime(db, id, 6);
    expect(janelaCurta).toMatchObject({ total_de_checks: 1, sucessos: 1, uptime: 100 });

    const janelaLonga = await resumoDeUptime(db, id, 48);
    expect(janelaLonga).toMatchObject({ total_de_checks: 2, sucessos: 1, uptime: 50 });
  });

  it('nao conta duas vezes quando a agregacao roda repetida', async () => {
    const id = await criarMonitor();
    for (let vez = 0; vez < 5; vez += 1) await gravarEm(id, 2, true, 50);

    await agregarHorasFechadas(db);
    await agregarHorasFechadas(db);
    await agregarHorasFechadas(db);

    const resumo = await resumoDeUptime(db, id, 24);
    expect(resumo.total_de_checks).toBe(5);
  });

  it('reescreve a hora quando chega resultado atrasado', async () => {
    const id = await criarMonitor();
    await gravarEm(id, 2, true, 50);
    await agregarHorasFechadas(db);

    await gravarEm(id, 2, false, 700);
    await agregarHorasFechadas(db);

    const resumo = await resumoDeUptime(db, id, 24);
    expect(resumo).toMatchObject({ total_de_checks: 2, sucessos: 1, uptime: 50 });
  });

  it('nao agrega a hora que ainda esta em andamento', async () => {
    const id = await criarMonitor();
    await gravarEm(id, 0, true, 50);

    expect(await agregarHorasFechadas(db)).toBe(0);
    expect(await db.selectFrom('agregados_hora').selectAll().execute()).toEqual([]);
  });

  it('guarda percentis e maximo de latencia por hora', async () => {
    const id = await criarMonitor();
    for (const latencia of [10, 20, 30, 40, 500]) await gravarEm(id, 1, true, latencia);

    await agregarHorasFechadas(db);

    const agregado = await db.selectFrom('agregados_hora').selectAll().executeTakeFirstOrThrow();
    expect(agregado).toMatchObject({
      total: 5,
      sucessos: 5,
      latencia_p50: 30,
      latencia_p95: 500,
      latencia_maxima: 500,
    });
  });

  it('separa os monitores no mesmo periodo', async () => {
    const primeiro = await criarMonitor();
    const segundo = await criarMonitor();

    await gravarEm(primeiro, 2, true, 50);
    await gravarEm(segundo, 2, false, 900);
    await agregarHorasFechadas(db);

    expect((await resumoDeUptime(db, primeiro, 24)).uptime).toBe(100);
    expect((await resumoDeUptime(db, segundo, 24)).uptime).toBe(0);
  });
});

describe('retencao', () => {
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

  it('apaga o historico cru antigo e preserva o agregado', async () => {
    const monitor = await db
      .insertInto('monitores')
      .values({
        nome: 'antigo',
        url: 'https://exemplo.com/saude',
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('resultados')
      .values(
        [40, 35, 2].map((diasAtras) => ({
          monitor_id: monitor.id,
          sucesso: true,
          codigo_http: 200,
          latencia_ms: 50,
          motivo_falha: null,
          detalhe: null,
          verificado_em: sql<Date>`now() - make_interval(days => ${diasAtras})`,
        })),
      )
      .execute();

    await db
      .insertInto('agregados_hora')
      .values({
        monitor_id: monitor.id,
        hora: sql<Date>`date_trunc('hour', now() - interval '40 days')`,
        total: 1,
        sucessos: 1,
        latencia_p50: 50,
        latencia_p95: 50,
        latencia_maxima: 50,
      })
      .execute();

    expect(await aplicarRetencao(db, 30)).toBe(2);

    const crus = await db.selectFrom('resultados').selectAll().execute();
    expect(crus).toHaveLength(1);

    const agregados = await db.selectFrom('agregados_hora').selectAll().execute();
    expect(agregados).toHaveLength(1);
  });
});

describe('serie por hora', () => {
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

  it('emenda horas fechadas com a hora corrente em ordem crescente', async () => {
    const monitor = await db
      .insertInto('monitores')
      .values({
        nome: 'alvo',
        url: 'https://exemplo.com/saude',
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const gravar = (horasAtras: number, sucesso: boolean): Promise<unknown> =>
      db
        .insertInto('resultados')
        .values({
          monitor_id: monitor.id,
          sucesso,
          codigo_http: sucesso ? 200 : 500,
          latencia_ms: 60,
          motivo_falha: sucesso ? null : 'status',
          detalhe: null,
          verificado_em: sql<Date>`date_trunc('hour', now()) - make_interval(hours => ${horasAtras}) + interval '5 minutes'`,
        })
        .execute();

    await gravar(2, true);
    await gravar(1, false);
    await gravar(0, true);
    await agregarHorasFechadas(db);

    const serie = await serieHoraria(db, monitor.id, 24);

    expect(serie).toHaveLength(3);
    expect(serie.map((ponto) => ponto.uptime)).toEqual([100, 0, 100]);
    expect(serie[0]!.hora.getTime()).toBeLessThan(serie[2]!.hora.getTime());
  });
});
