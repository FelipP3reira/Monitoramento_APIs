import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ResultadoDoCheck } from '../src/checagem/executor.ts';
import type { BancoDeDados } from '../src/db/conexao.ts';
import {
  contarSequencias,
  decidirTransicao,
  historicoNecessario,
} from '../src/dominio/incidentes.ts';
import { buscarIncidenteAberto, listarIncidentes } from '../src/dominio/repositorio-incidentes.ts';
import { gravarResultado } from '../src/dominio/repositorio-resultados.ts';
import { atualizarIncidente } from '../src/dominio/servico-incidentes.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';

const sequenciaDe = (...sucessos: boolean[]): { sucesso: boolean }[] =>
  sucessos.map((sucesso) => ({ sucesso }));

describe('contagem de sequencia', () => {
  it('devolve zero quando nao ha historico', () => {
    expect(contarSequencias([])).toEqual({ falhasSeguidas: 0, sucessosSeguidos: 0 });
  });

  it('conta falhas seguidas a partir do resultado mais novo', () => {
    expect(contarSequencias(sequenciaDe(false, false, false, true))).toEqual({
      falhasSeguidas: 3,
      sucessosSeguidos: 0,
    });
  });

  it('conta sucessos seguidos a partir do resultado mais novo', () => {
    expect(contarSequencias(sequenciaDe(true, true, false))).toEqual({
      falhasSeguidas: 0,
      sucessosSeguidos: 2,
    });
  });

  it('para a contagem no primeiro resultado diferente', () => {
    expect(contarSequencias(sequenciaDe(false, true, false, false, false))).toEqual({
      falhasSeguidas: 1,
      sucessosSeguidos: 0,
    });
  });
});

describe('decisao de transicao', () => {
  const politica = { falhasParaAbrir: 3, sucessosParaFechar: 2 };

  it('abre exatamente no limiar de falhas', () => {
    expect(decidirTransicao(false, { falhasSeguidas: 2, sucessosSeguidos: 0 }, politica)).toBe(
      'nada',
    );
    expect(decidirTransicao(false, { falhasSeguidas: 3, sucessosSeguidos: 0 }, politica)).toBe(
      'abrir',
    );
  });

  it('nao abre um segundo incidente com um ja aberto', () => {
    expect(decidirTransicao(true, { falhasSeguidas: 9, sucessosSeguidos: 0 }, politica)).toBe(
      'nada',
    );
  });

  it('fecha exatamente no limiar de sucessos', () => {
    expect(decidirTransicao(true, { falhasSeguidas: 0, sucessosSeguidos: 1 }, politica)).toBe(
      'nada',
    );
    expect(decidirTransicao(true, { falhasSeguidas: 0, sucessosSeguidos: 2 }, politica)).toBe(
      'fechar',
    );
  });

  it('nao fecha nada quando nao ha incidente aberto', () => {
    expect(decidirTransicao(false, { falhasSeguidas: 0, sucessosSeguidos: 50 }, politica)).toBe(
      'nada',
    );
  });

  it('nao abre com alvo instavel que alterna falha e sucesso', () => {
    // O historico alternado nunca acumula tres falhas seguidas.
    for (const historico of [
      sequenciaDe(false, true, false, true, false),
      sequenciaDe(false, false, true, false, false),
      sequenciaDe(true, false, false, true, false),
    ]) {
      expect(decidirTransicao(false, contarSequencias(historico), politica)).toBe('nada');
    }
  });

  it('le so o historico que muda a decisao', () => {
    expect(historicoNecessario({ falhasParaAbrir: 3, sucessosParaFechar: 2 })).toBe(3);
    expect(historicoNecessario({ falhasParaAbrir: 2, sucessosParaFechar: 5 })).toBe(5);
  });
});

describe('incidente no banco', () => {
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

  const politica = { falhasParaAbrir: 3, sucessosParaFechar: 2 };

  const falha: ResultadoDoCheck = {
    sucesso: false,
    codigo_http: 503,
    latencia_ms: 12,
    motivo_falha: 'status',
    detalhe: 'respondeu 503, esperava 200',
  };

  const sucesso: ResultadoDoCheck = {
    sucesso: true,
    codigo_http: 200,
    latencia_ms: 30,
    motivo_falha: null,
    detalhe: null,
  };

  async function criarMonitorNoBanco(): Promise<string> {
    const linha = await db
      .insertInto('monitores')
      .values({
        nome: 'alvo',
        url: 'https://exemplo.com/saude',
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
        falhas_para_abrir: politica.falhasParaAbrir,
        sucessos_para_fechar: politica.sucessosParaFechar,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return linha.id;
  }

  async function checar(monitorId: string, resultado: ResultadoDoCheck): Promise<string> {
    await gravarResultado(db, monitorId, resultado);
    const decisao = await atualizarIncidente(db, monitorId, politica, resultado);
    return decisao.acao;
  }

  it('sobe e desce passando pelas bordas certas', async () => {
    const id = await criarMonitorNoBanco();

    expect(await checar(id, falha)).toBe('nada');
    expect(await checar(id, falha)).toBe('nada');
    expect(await checar(id, falha)).toBe('abrir');
    expect(await checar(id, falha)).toBe('nada');
    expect(await checar(id, sucesso)).toBe('nada');
    expect(await checar(id, sucesso)).toBe('fechar');
    expect(await checar(id, sucesso)).toBe('nada');
  });

  it('guarda o motivo da falha que abriu o incidente', async () => {
    const id = await criarMonitorNoBanco();

    await checar(id, falha);
    await checar(id, falha);
    await checar(id, falha);

    const aberto = await buscarIncidenteAberto(db, id);
    expect(aberto).toMatchObject({ motivo: 'status', falhas: 3 });
  });

  it('conta as falhas que continuam durante o incidente', async () => {
    const id = await criarMonitorNoBanco();

    for (let vez = 0; vez < 5; vez += 1) await checar(id, falha);

    const aberto = await buscarIncidenteAberto(db, id);
    expect(aberto?.falhas).toBe(5);
  });

  it('sucesso no meio da queda zera a contagem e adia a abertura', async () => {
    const id = await criarMonitorNoBanco();

    await checar(id, falha);
    await checar(id, falha);
    await checar(id, sucesso);
    await checar(id, falha);
    await checar(id, falha);

    expect(await buscarIncidenteAberto(db, id)).toBeUndefined();

    expect(await checar(id, falha)).toBe('abrir');
  });

  it('falha no meio da recuperacao mantem o incidente aberto', async () => {
    const id = await criarMonitorNoBanco();

    for (let vez = 0; vez < 3; vez += 1) await checar(id, falha);
    await checar(id, sucesso);
    expect(await checar(id, falha)).toBe('nada');
    await checar(id, sucesso);

    expect(await buscarIncidenteAberto(db, id)).toBeDefined();
    expect(await checar(id, sucesso)).toBe('fechar');
  });

  it('registra dois incidentes separados numa queda, recuperacao e nova queda', async () => {
    const id = await criarMonitorNoBanco();

    for (let vez = 0; vez < 3; vez += 1) await checar(id, falha);
    for (let vez = 0; vez < 2; vez += 1) await checar(id, sucesso);
    for (let vez = 0; vez < 3; vez += 1) await checar(id, falha);

    const incidentes = await listarIncidentes(db, id, 10);
    expect(incidentes).toHaveLength(2);
    expect(incidentes[0]?.fechado_em).toBeNull();
    expect(incidentes[1]?.fechado_em).not.toBeNull();
  });

  it('o banco recusa um segundo incidente aberto no mesmo monitor', async () => {
    const id = await criarMonitorNoBanco();
    for (let vez = 0; vez < 3; vez += 1) await checar(id, falha);

    const insercaoDireta = db
      .insertInto('incidentes')
      .values({ monitor_id: id, motivo: 'status', falhas: 1 })
      .execute();

    await expect(insercaoDireta).rejects.toThrow(/incidentes_um_aberto_por_monitor/);
  });

  it('abrir em paralelo cria um incidente so', async () => {
    const id = await criarMonitorNoBanco();
    await gravarResultado(db, id, falha);
    await gravarResultado(db, id, falha);
    await gravarResultado(db, id, falha);

    const decisoes = await Promise.all(
      Array.from({ length: 4 }, () => atualizarIncidente(db, id, politica, falha)),
    );

    expect(decisoes.filter((decisao) => decisao.acao === 'abrir')).toHaveLength(1);
    expect(await listarIncidentes(db, id, 10)).toHaveLength(1);
  });

  it('nao mexe em incidente de outro monitor', async () => {
    const primeiro = await criarMonitorNoBanco();
    const segundo = await criarMonitorNoBanco();

    for (let vez = 0; vez < 3; vez += 1) await checar(primeiro, falha);
    for (let vez = 0; vez < 3; vez += 1) await checar(segundo, sucesso);

    expect(await buscarIncidenteAberto(db, primeiro)).toBeDefined();
    expect(await buscarIncidenteAberto(db, segundo)).toBeUndefined();
  });

  it('ignora resultado antigo de outra epoca ao contar a sequencia', async () => {
    const id = await criarMonitorNoBanco();

    await db
      .insertInto('resultados')
      .values(
        [1, 2, 3].map((diasAtras) => ({
          monitor_id: id,
          sucesso: false,
          motivo_falha: 'status' as const,
          detalhe: 'antigo',
          codigo_http: 500,
          latencia_ms: 10,
          verificado_em: sql<Date>`now() - make_interval(days => ${diasAtras})`,
        })),
      )
      .execute();

    // O check de agora foi bem: a sequencia corrente e de sucesso, nao de falha.
    expect(await checar(id, sucesso)).toBe('nada');
    expect(await buscarIncidenteAberto(db, id)).toBeUndefined();
  });
});
