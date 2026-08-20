import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import type { BancoDeDados } from '../src/db/conexao.ts';
import { lerCabecalhos } from '../src/dominio/repositorio-monitores.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';

const autorizado = { authorization: `Bearer ${config.API_TOKEN}` };

const monitorValido = {
  nome: 'API publica',
  url: 'https://exemplo.com/saude',
  intervalo_segundos: 60,
};

let db: BancoDeDados;
let app: FastifyInstance;

beforeAll(async () => {
  db = await prepararBanco();
  app = await montarApp({ db });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  await limparBanco(db);
});

describe('protecao das rotas', () => {
  it('deixa a rota de saude aberta', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/saude' });
    expect(resposta.statusCode).toBe(200);
  });

  it('recusa chamada sem token', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/api/monitores' });
    expect(resposta.statusCode).toBe(401);
  });

  it('recusa token errado do mesmo tamanho', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/api/monitores',
      headers: { authorization: `Bearer ${'x'.repeat(config.API_TOKEN.length)}` },
    });
    expect(resposta.statusCode).toBe(401);
  });
});

describe('cadastro de monitor', () => {
  it('cria com os padroes preenchidos', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: monitorValido,
    });

    expect(resposta.statusCode).toBe(201);
    const monitor = resposta.json();
    expect(monitor).toMatchObject({
      nome: 'API publica',
      metodo: 'GET',
      status_esperado: [200],
      falhas_para_abrir: 3,
      sucessos_para_fechar: 2,
      ativo: true,
      assertivas: [],
    });
    expect(monitor.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('guarda os cabecalhos cifrados e nunca devolve os valores', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, cabecalhos: { Authorization: 'Bearer segredo-do-alvo' } },
    });

    expect(resposta.statusCode).toBe(201);
    expect(resposta.body).not.toContain('segredo-do-alvo');
    expect(resposta.json().cabecalhos_definidos).toEqual(['Authorization']);

    const guardado = await db
      .selectFrom('monitores')
      .select('cabecalhos_cifrados')
      .executeTakeFirstOrThrow();

    expect(guardado.cabecalhos_cifrados).not.toContain('segredo-do-alvo');
    expect(lerCabecalhos(guardado.cabecalhos_cifrados)).toEqual({
      Authorization: 'Bearer segredo-do-alvo',
    });
  });

  it('recusa URL que aponta para a rede interna', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, url: 'http://169.254.169.254/latest/meta-data/' },
    });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().problemas[0].mensagem).toMatch(/rede interna/i);
  });

  it('recusa cabecalho com quebra de linha', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: {
        ...monitorValido,
        cabecalhos: { 'X-Teste': 'valor\r\nX-Injetado: sim' },
      },
    });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().problemas[0].mensagem).toMatch(/quebra de linha/i);
  });

  it('recusa cabecalho controlado pelo proprio monitor', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, cabecalhos: { 'Transfer-Encoding': 'chunked' } },
    });

    expect(resposta.statusCode).toBe(400);
  });

  it('recusa intervalo abaixo do minimo', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, intervalo_segundos: 5 },
    });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().problemas[0].campo).toBe('intervalo_segundos');
  });

  it('recusa assertiva de tipo desconhecido', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, assertivas: [{ tipo: 'roda_javascript', valor: 'x' }] },
    });

    expect(resposta.statusCode).toBe(400);
  });
});

describe('leitura, alteracao e remocao', () => {
  const criar = async (extras: Record<string, unknown> = {}): Promise<string> => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/api/monitores',
      headers: autorizado,
      payload: { ...monitorValido, ...extras },
    });
    return resposta.json().id as string;
  };

  it('lista o que foi criado', async () => {
    await criar({ nome: 'primeiro' });
    await criar({ nome: 'segundo' });

    const resposta = await app.inject({
      method: 'GET',
      url: '/api/monitores',
      headers: autorizado,
    });
    expect(resposta.json()).toHaveLength(2);
  });

  it('devolve 404 para id que nao existe', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/api/monitores/00000000-0000-4000-8000-000000000000',
      headers: autorizado,
    });
    expect(resposta.statusCode).toBe(404);
  });

  it('recusa id que nao e uuid', async () => {
    const resposta = await app.inject({
      method: 'GET',
      url: '/api/monitores/nao-e-uuid',
      headers: autorizado,
    });
    expect(resposta.statusCode).toBe(400);
  });

  it('altera so o campo enviado', async () => {
    const id = await criar();

    const resposta = await app.inject({
      method: 'PATCH',
      url: `/api/monitores/${id}`,
      headers: autorizado,
      payload: { ativo: false },
    });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ ativo: false, nome: 'API publica' });
  });

  it('nao devolve os outros campos para o padrao ao alterar um so', async () => {
    const id = await criar({ metodo: 'POST', timeout_ms: 9000, falhas_para_abrir: 7 });

    const resposta = await app.inject({
      method: 'PATCH',
      url: `/api/monitores/${id}`,
      headers: autorizado,
      payload: { nome: 'nome novo' },
    });

    expect(resposta.json()).toMatchObject({
      nome: 'nome novo',
      metodo: 'POST',
      timeout_ms: 9000,
      falhas_para_abrir: 7,
    });
  });

  it('recusa alteracao vazia', async () => {
    const id = await criar();

    const resposta = await app.inject({
      method: 'PATCH',
      url: `/api/monitores/${id}`,
      headers: autorizado,
      payload: {},
    });

    expect(resposta.statusCode).toBe(400);
  });

  it('remove e depois nao encontra mais', async () => {
    const id = await criar();

    const remocao = await app.inject({
      method: 'DELETE',
      url: `/api/monitores/${id}`,
      headers: autorizado,
    });
    expect(remocao.statusCode).toBe(204);

    const busca = await app.inject({
      method: 'GET',
      url: `/api/monitores/${id}`,
      headers: autorizado,
    });
    expect(busca.statusCode).toBe(404);
  });
});

describe('limite de chamadas', () => {
  it('corta a rajada na rota de escrita', async () => {
    const comLimiteBaixo = await montarApp({ db, limiteDeEscrita: 3 });

    const respostas = await Promise.all(
      Array.from({ length: 5 }, () =>
        comLimiteBaixo.inject({
          method: 'POST',
          url: '/api/monitores',
          headers: autorizado,
          payload: monitorValido,
        }),
      ),
    );

    expect(respostas.filter((resposta) => resposta.statusCode === 429).length).toBeGreaterThan(0);
    await comLimiteBaixo.close();
  });
});
