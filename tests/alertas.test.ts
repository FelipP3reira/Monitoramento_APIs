import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { config } from '../src/config.ts';

import { CanalDeWebhook } from '../src/alertas/canal-webhook.ts';
import { ClienteHttpSeguro, type ClienteHttp } from '../src/alertas/cliente-http.ts';
import { enfileirarAlertas, entregarPendentes } from '../src/alertas/despachante.ts';
import { RegistroDeCanais } from '../src/alertas/registro.ts';
import {
  FalhaDeEntrega,
  formatarDuracao,
  resumirAlerta,
  type Alerta,
  type Canal,
} from '../src/alertas/tipos.ts';
import { criarWorker } from '../src/agendador/worker.ts';
import type { BancoDeDados } from '../src/db/conexao.ts';
import { criarCanal } from '../src/dominio/repositorio-canais.ts';
import { assinar, assinaturaConfere } from '../src/seguranca/hmac.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';
import { resolverParaLoopback, subirServidor, type Manipulador } from './apoio/servidor.ts';

const alertaDeExemplo: Alerta = {
  evento: 'abriu',
  incidenteId: '00000000-0000-4000-8000-000000000001',
  monitorNome: 'API de pagamentos',
  monitorUrl: 'https://exemplo.com/saude',
  motivo: 'status',
  detalhe: 'respondeu 503, esperava 200',
  abertoEm: new Date('2026-08-20T10:00:00Z'),
  fechadoEm: null,
  duracaoSegundos: null,
};

describe('texto do alerta', () => {
  it('formata duracao em escala legivel', () => {
    expect(formatarDuracao(45)).toBe('45s');
    expect(formatarDuracao(60)).toBe('1min');
    expect(formatarDuracao(3599)).toBe('59min');
    expect(formatarDuracao(3600)).toBe('1h');
    expect(formatarDuracao(5400)).toBe('1h30min');
  });

  it('resume abertura e fechamento de formas diferentes', () => {
    expect(resumirAlerta(alertaDeExemplo)).toBe('API de pagamentos caiu: status');
    expect(resumirAlerta({ ...alertaDeExemplo, evento: 'fechou', duracaoSegundos: 5400 })).toBe(
      'API de pagamentos voltou depois de 1h30min',
    );
  });
});

describe('assinatura do webhook', () => {
  it('confere a assinatura que ela mesma gera', () => {
    const assinatura = assinar('{"evento":"abriu"}', 'segredo-bem-comprido-123');
    expect(assinaturaConfere('{"evento":"abriu"}', 'segredo-bem-comprido-123', assinatura)).toBe(
      true,
    );
  });

  it('recusa corpo alterado e segredo errado', () => {
    const assinatura = assinar('{"evento":"abriu"}', 'segredo-bem-comprido-123');
    expect(assinaturaConfere('{"evento":"fechou"}', 'segredo-bem-comprido-123', assinatura)).toBe(
      false,
    );
    expect(assinaturaConfere('{"evento":"abriu"}', 'outro-segredo-comprido', assinatura)).toBe(
      false,
    );
    expect(assinaturaConfere('{"evento":"abriu"}', 'segredo-bem-comprido-123', 'curta')).toBe(
      false,
    );
  });
});

describe('canal de webhook', () => {
  class ClienteFalso implements ClienteHttp {
    corpo = '';
    cabecalhos: Record<string, string> = {};

    constructor(private readonly status: number) {}

    postar(
      _url: string,
      corpo: string,
      cabecalhos: Record<string, string>,
    ): Promise<{ status: number }> {
      this.corpo = corpo;
      this.cabecalhos = cabecalhos;
      return Promise.resolve({ status: this.status });
    }
  }

  it('assina o corpo exato que vai no fio', async () => {
    const cliente = new ClienteFalso(200);
    await new CanalDeWebhook(cliente).enviar(
      alertaDeExemplo,
      'https://exemplo.com/hook',
      'segredo-bem-comprido-123',
    );

    const assinatura = cliente.cabecalhos['X-Monitoramento-Assinatura'] ?? '';
    expect(assinatura.startsWith('sha256=')).toBe(true);
    expect(assinaturaConfere(cliente.corpo, 'segredo-bem-comprido-123', assinatura.slice(7))).toBe(
      true,
    );
    expect(JSON.parse(cliente.corpo)).toMatchObject({ evento: 'abriu', motivo: 'status' });
  });

  it('nao assina quando o canal nao tem segredo', async () => {
    const cliente = new ClienteFalso(204);
    await new CanalDeWebhook(cliente).enviar(alertaDeExemplo, 'https://exemplo.com/hook', null);

    expect(cliente.cabecalhos['X-Monitoramento-Assinatura']).toBeUndefined();
  });

  it.each([
    [400, true],
    [404, true],
    [410, true],
    [408, false],
    [429, false],
    [500, false],
    [503, false],
  ])('trata %i como falha permanente=%s', async (status, permanente) => {
    const canal = new CanalDeWebhook(new ClienteFalso(status));

    await expect(
      canal.enviar(alertaDeExemplo, 'https://exemplo.com/hook', null),
    ).rejects.toMatchObject({ permanente });
  });

  it('recusa webhook apontado para a rede interna', async () => {
    const canal = new CanalDeWebhook(new ClienteHttpSeguro());

    await expect(
      canal.enviar(alertaDeExemplo, 'http://169.254.169.254/hook', null),
    ).rejects.toThrow(/rede interna/i);
  });
});

describe('despacho no banco', () => {
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

  class CanalDeTeste implements Canal {
    readonly recebidos: Alerta[] = [];

    constructor(
      readonly tipo: 'email' | 'webhook',
      private readonly erro?: Error,
    ) {}

    enviar(alerta: Alerta): Promise<void> {
      if (this.erro !== undefined) return Promise.reject(this.erro);
      this.recebidos.push(alerta);
      return Promise.resolve();
    }
  }

  async function montarMonitorComIncidente(): Promise<{ monitorId: string; incidenteId: string }> {
    const monitor = await db
      .insertInto('monitores')
      .values({
        nome: 'API de pagamentos',
        url: 'https://exemplo.com/saude',
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const incidente = await db
      .insertInto('incidentes')
      .values({
        monitor_id: monitor.id,
        motivo: 'status',
        detalhe: 'respondeu 503, esperava 200',
        falhas: 3,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { monitorId: monitor.id, incidenteId: incidente.id };
  }

  it('enfileira um aviso por canal ativo, incluindo o global', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();

    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });
    await criarCanal(db, {
      monitor_id: null,
      tipo: 'webhook',
      destino: 'https://exemplo.com/hook',
      ativo: true,
    });
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'desligado@exemplo.com',
      ativo: false,
    });

    expect(await enfileirarAlertas(db, monitorId, incidenteId, 'abriu')).toBe(2);
  });

  it('nao enfileira o mesmo aviso duas vezes', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });

    expect(await enfileirarAlertas(db, monitorId, incidenteId, 'abriu')).toBe(1);
    expect(await enfileirarAlertas(db, monitorId, incidenteId, 'abriu')).toBe(0);
    expect(await enfileirarAlertas(db, monitorId, incidenteId, 'abriu')).toBe(0);

    // Fechamento e outro evento, entao esse passa.
    expect(await enfileirarAlertas(db, monitorId, incidenteId, 'fechou')).toBe(1);
  });

  it('nao enfileira nada quando ninguem chamou em paralelo duas vezes', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });

    const chamadas = await Promise.all(
      Array.from({ length: 5 }, () => enfileirarAlertas(db, monitorId, incidenteId, 'abriu')),
    );

    expect(chamadas.reduce((soma, quantidade) => soma + quantidade, 0)).toBe(1);
  });

  it('entrega o pendente e marca como enviado', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });
    await enfileirarAlertas(db, monitorId, incidenteId, 'abriu');

    const canal = new CanalDeTeste('email');
    const saldo = await entregarPendentes(db, new RegistroDeCanais([canal]));

    expect(saldo).toEqual({ enviados: 1, adiados: 0, desistidos: 0 });
    expect(canal.recebidos[0]).toMatchObject({
      evento: 'abriu',
      monitorNome: 'API de pagamentos',
      motivo: 'status',
    });

    const linha = await db.selectFrom('alertas_enviados').selectAll().executeTakeFirstOrThrow();
    expect(linha.situacao).toBe('enviado');
    expect(linha.enviado_em).not.toBeNull();

    // Nada mais pendente: nao reenvia na proxima passada.
    expect(await entregarPendentes(db, new RegistroDeCanais([canal]))).toEqual({
      enviados: 0,
      adiados: 0,
      desistidos: 0,
    });
  });

  it('adia a falha temporaria com espera crescente', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });
    await enfileirarAlertas(db, monitorId, incidenteId, 'abriu');

    const canal = new CanalDeTeste('email', new FalhaDeEntrega('smtp fora do ar', false));
    expect(await entregarPendentes(db, new RegistroDeCanais([canal]))).toEqual({
      enviados: 0,
      adiados: 1,
      desistidos: 0,
    });

    const linha = await db.selectFrom('alertas_enviados').selectAll().executeTakeFirstOrThrow();
    expect(linha).toMatchObject({ situacao: 'pendente', tentativas: 1 });
    expect(linha.ultimo_erro).toBe('smtp fora do ar');
    expect(linha.proxima_tentativa_em.getTime()).toBeGreaterThan(Date.now());

    // Ainda dentro da espera: a passada seguinte nao pega nada.
    expect(await entregarPendentes(db, new RegistroDeCanais([canal]))).toEqual({
      enviados: 0,
      adiados: 0,
      desistidos: 0,
    });
  });

  it('desiste na hora da falha permanente, sem gastar tentativa', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'webhook',
      destino: 'https://exemplo.com/hook',
      ativo: true,
    });
    await enfileirarAlertas(db, monitorId, incidenteId, 'abriu');

    const canal = new CanalDeTeste('webhook', new FalhaDeEntrega('o webhook respondeu 404', true));
    expect(await entregarPendentes(db, new RegistroDeCanais([canal]))).toEqual({
      enviados: 0,
      adiados: 0,
      desistidos: 1,
    });

    const linha = await db.selectFrom('alertas_enviados').selectAll().executeTakeFirstOrThrow();
    expect(linha).toMatchObject({ situacao: 'falhou', tentativas: 1 });
  });

  it('desiste depois de esgotar as tentativas', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });
    await enfileirarAlertas(db, monitorId, incidenteId, 'abriu');

    const registro = new RegistroDeCanais([
      new CanalDeTeste('email', new FalhaDeEntrega('smtp fora do ar', false)),
    ]);

    const saldos = [];
    for (let vez = 0; vez < 5; vez += 1) {
      saldos.push(await entregarPendentes(db, registro));
      // Encurta a espera para nao deixar o teste dependendo do relogio.
      await db
        .updateTable('alertas_enviados')
        .set({ proxima_tentativa_em: sql<Date>`now() - interval '1 second'` })
        .execute();
    }

    expect(saldos.map((saldo) => saldo.adiados)).toEqual([1, 1, 1, 1, 0]);
    expect(saldos[4]?.desistidos).toBe(1);

    const linha = await db.selectFrom('alertas_enviados').selectAll().executeTakeFirstOrThrow();
    expect(linha).toMatchObject({ situacao: 'falhou', tentativas: 5 });
  });

  it('marca como falhou quando nao existe canal do tipo cadastrado', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'webhook',
      destino: 'https://exemplo.com/hook',
      ativo: true,
    });
    await enfileirarAlertas(db, monitorId, incidenteId, 'abriu');

    const saldo = await entregarPendentes(db, new RegistroDeCanais([new CanalDeTeste('email')]));

    expect(saldo.desistidos).toBe(1);
  });

  it('leva a duracao no aviso de fechamento', async () => {
    const { monitorId, incidenteId } = await montarMonitorComIncidente();
    await criarCanal(db, {
      monitor_id: monitorId,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });

    // aberto_em e declarada como nao atualizavel no tipo da tabela de proposito,
    // entao o ajuste de cenario vai por SQL em vez de furar a tipagem.
    await sql`
      update incidentes
         set aberto_em = now() - interval '10 minutes',
             fechado_em = now()
       where id = ${incidenteId}::uuid
    `.execute(db);

    await enfileirarAlertas(db, monitorId, incidenteId, 'fechou');

    const canal = new CanalDeTeste('email');
    await entregarPendentes(db, new RegistroDeCanais([canal]));

    expect(canal.recebidos[0]?.duracaoSegundos).toBeCloseTo(600, -1);
    expect(resumirAlerta(canal.recebidos[0]!)).toMatch(/voltou depois de 10min/);
  });
});

describe('alerta ponta a ponta pelo worker', () => {
  let db: BancoDeDados;
  const paraFechar: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    db = await prepararBanco();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await limparBanco(db);
  });

  afterEach(async () => {
    await Promise.all(paraFechar.splice(0).map((fechar) => fechar()));
  });

  class CanalEspiao implements Canal {
    readonly tipo = 'email' as const;
    readonly recebidos: Alerta[] = [];

    enviar(alerta: Alerta): Promise<void> {
      this.recebidos.push(alerta);
      return Promise.resolve();
    }
  }

  it('avisa uma vez na queda e uma vez na volta, e nada no meio', async () => {
    let noAr = false;

    const manipulador: Manipulador = (_requisicao, resposta) => {
      resposta.writeHead(noAr ? 200 : 503);
      resposta.end(noAr ? 'ok' : 'fora');
    };

    const servidor = await subirServidor(manipulador);
    paraFechar.push(servidor.fechar);

    const monitor = await db
      .insertInto('monitores')
      .values({
        nome: 'alvo',
        url: `http://localhost:${servidor.porta}/saude`,
        intervalo_segundos: 60,
        assertivas: JSON.stringify([]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await criarCanal(db, {
      monitor_id: monitor.id,
      tipo: 'email',
      destino: 'plantao@exemplo.com',
      ativo: true,
    });

    const espiao = new CanalEspiao();
    const worker = criarWorker({
      db,
      registroDeCanais: new RegistroDeCanais([espiao]),
      dependenciasDoCheck: { resolverEndereco: resolverParaLoopback },
    });

    const vencerAgenda = (): Promise<unknown> =>
      db
        .updateTable('monitores')
        .set({ proximo_check_em: sql<Date>`now() - interval '1 second'` })
        .execute();

    // Seis checks com o alvo fora: o incidente abre no terceiro.
    for (let vez = 0; vez < 6; vez += 1) {
      await worker.cicloUnico();
      await worker.entregarAlertas();
      await vencerAgenda();
    }

    expect(espiao.recebidos.map((alerta) => alerta.evento)).toEqual(['abriu']);

    noAr = true;

    // Quatro checks com o alvo de volta: fecha no segundo.
    for (let vez = 0; vez < 4; vez += 1) {
      await worker.cicloUnico();
      await worker.entregarAlertas();
      await vencerAgenda();
    }

    expect(espiao.recebidos.map((alerta) => alerta.evento)).toEqual(['abriu', 'fechou']);
    expect(espiao.recebidos[0]?.motivo).toBe('status');
    expect(espiao.recebidos[1]?.duracaoSegundos).not.toBeNull();
  });
});

describe('cadastro de canal pela API', () => {
  let db: BancoDeDados;
  let app: FastifyInstance;
  const autorizado = { authorization: `Bearer ${config.API_TOKEN}` };

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
    await db.deleteFrom('canais_alerta').execute();
  });

  const cadastrar = async (corpo: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/canais', headers: autorizado, payload: corpo });

  it('cria canal de e-mail', async () => {
    const resposta = await cadastrar({ tipo: 'email', destino: 'plantao@exemplo.com' });

    expect(resposta.statusCode).toBe(201);
    expect(resposta.json()).toMatchObject({ tipo: 'email', tem_segredo: false, ativo: true });
  });

  it('recusa e-mail malformado', async () => {
    const resposta = await cadastrar({ tipo: 'email', destino: 'nao-e-email' });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().problemas[0].campo).toBe('destino');
  });

  it('recusa webhook apontado para a rede interna', async () => {
    const resposta = await cadastrar({
      tipo: 'webhook',
      destino: 'http://169.254.169.254/hook',
    });

    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().problemas[0].mensagem).toMatch(/rede interna/i);
  });

  it('guarda o segredo do webhook cifrado e nunca devolve', async () => {
    const resposta = await cadastrar({
      tipo: 'webhook',
      destino: 'https://exemplo.com/hook',
      segredo: 'segredo-bem-comprido-123',
    });

    expect(resposta.statusCode).toBe(201);
    expect(resposta.body).not.toContain('segredo-bem-comprido-123');
    expect(resposta.json().tem_segredo).toBe(true);

    const guardado = await db
      .selectFrom('canais_alerta')
      .select('segredo_cifrado')
      .executeTakeFirstOrThrow();
    expect(guardado.segredo_cifrado).not.toContain('segredo-bem-comprido-123');
  });

  it('remove canal e devolve 404 para id que nao existe', async () => {
    const criado = await cadastrar({ tipo: 'email', destino: 'plantao@exemplo.com' });
    const id = criado.json().id as string;

    const remocao = await app.inject({
      method: 'DELETE',
      url: `/api/canais/${id}`,
      headers: autorizado,
    });
    expect(remocao.statusCode).toBe(204);

    const denovo = await app.inject({
      method: 'DELETE',
      url: `/api/canais/${id}`,
      headers: autorizado,
    });
    expect(denovo.statusCode).toBe(404);
  });
});
