import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { liberarMonitor, reservarMonitores } from '../src/agendador/reserva.ts';
import { criarWorker } from '../src/agendador/worker.ts';
import { criarBanco, type BancoDeDados } from '../src/db/conexao.ts';

import { limparBanco, prepararBanco } from './apoio/banco.ts';
import { resolverParaLoopback, subirServidor, type Manipulador } from './apoio/servidor.ts';

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

interface CamposDoMonitor {
  nome?: string;
  url?: string;
  intervalo_segundos?: number;
  ativo?: boolean;
  vencidoHaSegundos?: number;
  reservadoPorSegundos?: number | null;
}

async function inserirMonitor(campos: CamposDoMonitor = {}): Promise<string> {
  const {
    nome = 'monitor',
    url = 'https://exemplo.com/saude',
    intervalo_segundos = 60,
    ativo = true,
    vencidoHaSegundos = 10,
    reservadoPorSegundos = null,
  } = campos;

  const linha = await db
    .insertInto('monitores')
    .values({
      nome,
      url,
      intervalo_segundos,
      ativo,
      assertivas: JSON.stringify([]),
      proximo_check_em: sql<Date>`now() - make_interval(secs => ${vencidoHaSegundos})`,
      reservado_ate:
        reservadoPorSegundos === null
          ? null
          : sql<Date>`now() + make_interval(secs => ${reservadoPorSegundos})`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return linha.id;
}

describe('reserva de monitores', () => {
  it('pega o que ja venceu e ignora o que ainda nao', async () => {
    const vencido = await inserirMonitor({ nome: 'vencido', vencidoHaSegundos: 30 });
    await inserirMonitor({ nome: 'futuro', vencidoHaSegundos: -300 });

    const reservados = await reservarMonitores(db, 10, 60);

    expect(reservados.map((monitor) => monitor.id)).toEqual([vencido]);
  });

  it('ignora monitor desligado', async () => {
    await inserirMonitor({ ativo: false });

    expect(await reservarMonitores(db, 10, 60)).toHaveLength(0);
  });

  it('respeita o tamanho do lote e comeca pelo mais atrasado', async () => {
    await inserirMonitor({ nome: 'atrasado', vencidoHaSegundos: 600 });
    await inserirMonitor({ nome: 'recente', vencidoHaSegundos: 5 });
    await inserirMonitor({ nome: 'meio', vencidoHaSegundos: 60 });

    const reservados = await reservarMonitores(db, 2, 60);

    expect(reservados).toHaveLength(2);
    const nomes = await db
      .selectFrom('monitores')
      .select(['nome'])
      .where(
        'id',
        'in',
        reservados.map((monitor) => monitor.id),
      )
      .execute();
    expect(nomes.map((linha) => linha.nome).sort()).toEqual(['atrasado', 'meio']);
  });

  it('nao entrega o mesmo monitor para dois workers', async () => {
    const criados = await Promise.all(
      Array.from({ length: 12 }, (_ignorado, indice) => inserirMonitor({ nome: `m${indice}` })),
    );

    const outroDb = criarBanco();
    try {
      const [primeiro, segundo] = await Promise.all([
        reservarMonitores(db, 12, 60),
        reservarMonitores(outroDb, 12, 60),
      ]);

      const idsDoPrimeiro = new Set(primeiro.map((monitor) => monitor.id));
      const repetidos = segundo.filter((monitor) => idsDoPrimeiro.has(monitor.id));

      expect(repetidos).toEqual([]);
      expect(primeiro.length + segundo.length).toBeLessThanOrEqual(criados.length);
    } finally {
      await outroDb.destroy();
    }
  });

  it('pula a linha travada por outra transacao em vez de ficar esperando', async () => {
    const travado = await inserirMonitor({ nome: 'travado', vencidoHaSegundos: 600 });
    const livre = await inserirMonitor({ nome: 'livre', vencidoHaSegundos: 300 });

    const outroDb = criarBanco();
    let soltarTravamento = (): void => {};
    const travamentoAtivo = new Promise<void>((pronto) => {
      soltarTravamento = pronto;
    });

    const transacao = outroDb.transaction().execute(async (transacaoAberta) => {
      await transacaoAberta
        .selectFrom('monitores')
        .select('id')
        .where('id', '=', travado)
        .forUpdate()
        .execute();
      await travamentoAtivo;
    });

    try {
      // Espera o select acima efetivamente segurar a linha.
      await new Promise((pronto) => setTimeout(pronto, 150));

      const inicio = Date.now();
      const reservados = await reservarMonitores(db, 10, 60);
      const duracao = Date.now() - inicio;

      expect(reservados.map((monitor) => monitor.id)).toEqual([livre]);
      // Sem o skip locked isso ficaria bloqueado ate a outra transacao terminar.
      expect(duracao).toBeLessThan(1000);
    } finally {
      soltarTravamento();
      await transacao;
      await outroDb.destroy();
    }
  });

  it('nao mexe em monitor com reserva ainda valida', async () => {
    await inserirMonitor({ reservadoPorSegundos: 120 });

    expect(await reservarMonitores(db, 10, 60)).toHaveLength(0);
  });

  it('devolve para a fila o monitor cuja reserva venceu', async () => {
    const abandonado = await inserirMonitor({ reservadoPorSegundos: -5 });

    const reservados = await reservarMonitores(db, 10, 60);

    expect(reservados.map((monitor) => monitor.id)).toEqual([abandonado]);
  });

  it('reagenda para o futuro e solta a reserva ao liberar', async () => {
    const id = await inserirMonitor();
    await reservarMonitores(db, 10, 60);

    await liberarMonitor(db, id, 120);

    const monitor = await db
      .selectFrom('monitores')
      .select(['proximo_check_em', 'reservado_ate'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(monitor.reservado_ate).toBeNull();
    expect(monitor.proximo_check_em.getTime()).toBeGreaterThan(Date.now());
    expect(await reservarMonitores(db, 10, 60)).toHaveLength(0);
  });
});

describe('ciclo do worker', () => {
  const workerLocal = (): ReturnType<typeof criarWorker> =>
    criarWorker({ db, dependenciasDoCheck: { resolverEndereco: resolverParaLoopback } });

  async function monitorApontandoPara(
    manipulador: Manipulador,
    caminho = '/saude',
  ): Promise<string> {
    const servidor = await subirServidor(manipulador);
    paraFechar.push(servidor.fechar);
    return inserirMonitor({ url: `http://localhost:${servidor.porta}${caminho}` });
  }

  it('nao faz nada quando nao ha monitor vencido', async () => {
    expect(await workerLocal().cicloUnico()).toBe(0);
  });

  it('grava o resultado bem-sucedido e reagenda o monitor', async () => {
    const id = await monitorApontandoPara((_requisicao, resposta) => {
      resposta.writeHead(200);
      resposta.end('no ar');
    });

    expect(await workerLocal().cicloUnico()).toBe(1);

    const resultado = await db
      .selectFrom('resultados')
      .selectAll()
      .where('monitor_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(resultado).toMatchObject({ sucesso: true, codigo_http: 200, motivo_falha: null });
    expect(resultado.latencia_ms).toBeGreaterThanOrEqual(0);

    const monitor = await db
      .selectFrom('monitores')
      .select(['reservado_ate', 'proximo_check_em'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(monitor.reservado_ate).toBeNull();
    expect(monitor.proximo_check_em.getTime()).toBeGreaterThan(Date.now());
  });

  it('grava a falha com o motivo que a causou', async () => {
    const id = await monitorApontandoPara((_requisicao, resposta) => {
      resposta.writeHead(500);
      resposta.end('quebrou');
    });

    await workerLocal().cicloUnico();

    const resultado = await db
      .selectFrom('resultados')
      .selectAll()
      .where('monitor_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(resultado).toMatchObject({
      sucesso: false,
      codigo_http: 500,
      motivo_falha: 'status',
    });
  });

  it('registra falha de rede quando o alvo cai na rede interna', async () => {
    // Sem trocar o resolvedor: aqui o caminho de producao tem que barrar.
    const id = await inserirMonitor({ url: 'http://localhost:9/saude' });

    await criarWorker({ db }).cicloUnico();

    const resultado = await db
      .selectFrom('resultados')
      .select(['sucesso', 'motivo_falha'])
      .where('monitor_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(resultado).toEqual({ sucesso: false, motivo_falha: 'bloqueado' });
  });

  it('processa o lote inteiro em um ciclo', async () => {
    for (let indice = 0; indice < 3; indice += 1) {
      await monitorApontandoPara((_requisicao, resposta) => {
        resposta.writeHead(200);
        resposta.end('ok');
      });
    }

    expect(await workerLocal().cicloUnico()).toBe(3);

    const total = await db
      .selectFrom('resultados')
      .select(({ fn }) => fn.countAll<number>().as('quantidade'))
      .executeTakeFirstOrThrow();

    expect(total.quantidade).toBe(3);
  });

  it('vira resultado de falha, e nao excecao, quando a resolucao quebra', async () => {
    const id = await inserirMonitor({ url: 'https://exemplo.com/saude' });
    const falhasInesperadas: string[] = [];

    const worker = criarWorker({
      db,
      dependenciasDoCheck: {
        resolverEndereco: () => Promise.reject(new Error('resolvedor quebrado')),
      },
      aoFalhar: (monitorId) => falhasInesperadas.push(monitorId),
    });

    await worker.cicloUnico();

    const resultado = await db
      .selectFrom('resultados')
      .select(['sucesso', 'motivo_falha'])
      .where('monitor_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(resultado).toEqual({ sucesso: false, motivo_falha: 'conexao' });
    expect(falhasInesperadas).toEqual([]);

    const monitor = await db
      .selectFrom('monitores')
      .select('reservado_ate')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(monitor.reservado_ate).toBeNull();
  });
});
