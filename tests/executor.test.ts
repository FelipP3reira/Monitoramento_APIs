import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  executarCheck,
  type MonitorParaCheck,
  type ResultadoDoCheck,
} from '../src/checagem/executor.ts';

import { resolverParaLoopback, subirServidor, type Manipulador } from './apoio/servidor.ts';

const paraFechar: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(paraFechar.splice(0).map((fechar) => fechar()));
});

function monitorBase(porta: number, extras: Partial<MonitorParaCheck> = {}): MonitorParaCheck {
  return {
    url: `http://localhost:${porta}/saude`,
    metodo: 'GET',
    cabecalhos: {},
    corpo: null,
    timeout_ms: 3000,
    status_esperado: [200],
    latencia_maxima_ms: null,
    assertivas: [],
    ...extras,
  };
}

async function checar(
  manipulador: Manipulador,
  extras: Partial<MonitorParaCheck> = {},
): Promise<ResultadoDoCheck> {
  const servidor = await subirServidor(manipulador);
  paraFechar.push(servidor.fechar);

  return executarCheck(monitorBase(servidor.porta, extras), {
    resolverEndereco: resolverParaLoopback,
  });
}

const respondeOk: Manipulador = (_requisicao, resposta) => {
  resposta.writeHead(200, { 'content-type': 'text/plain' });
  resposta.end('tudo certo');
};

describe('status e conexao', () => {
  it('aprova quando o status bate', async () => {
    const resultado = await checar(respondeOk);

    expect(resultado.sucesso).toBe(true);
    expect(resultado.codigo_http).toBe(200);
    expect(resultado.motivo_falha).toBeNull();
    expect(resultado.latencia_ms).toBeGreaterThanOrEqual(0);
  });

  it('reprova status fora da lista esperada', async () => {
    const resultado = await checar((_requisicao, resposta) => {
      resposta.writeHead(503);
      resposta.end('fora do ar');
    });

    expect(resultado).toMatchObject({ sucesso: false, codigo_http: 503, motivo_falha: 'status' });
    expect(resultado.detalhe).toMatch(/respondeu 503/);
  });

  it('aceita mais de um status como valido', async () => {
    const resultado = await checar(
      (_requisicao, resposta) => {
        resposta.writeHead(204);
        resposta.end();
      },
      { status_esperado: [200, 204] },
    );

    expect(resultado.sucesso).toBe(true);
  });

  it('marca timeout quando o alvo nao responde', async () => {
    const resultado = await checar(
      () => {
        // De proposito: nunca responde.
      },
      { timeout_ms: 300 },
    );

    expect(resultado).toMatchObject({ sucesso: false, motivo_falha: 'timeout', codigo_http: null });
  });

  it('marca falha de conexao quando ninguem escuta na porta', async () => {
    const servidor = await subirServidor(respondeOk);
    const porta = servidor.porta;
    await servidor.fechar();

    const resultado = await executarCheck(monitorBase(porta), {
      resolverEndereco: resolverParaLoopback,
    });

    expect(resultado).toMatchObject({ sucesso: false, motivo_falha: 'conexao' });
  });
});

describe('latencia', () => {
  it('reprova quando passa do limite', async () => {
    const resultado = await checar(
      (_requisicao, resposta) => {
        setTimeout(() => {
          resposta.writeHead(200);
          resposta.end('demorei');
        }, 250);
      },
      { latencia_maxima_ms: 50 },
    );

    expect(resultado).toMatchObject({ sucesso: false, motivo_falha: 'latencia', codigo_http: 200 });
    expect(resultado.detalhe).toMatch(/o limite e 50ms/);
  });

  it('reclama do status antes de reclamar da lentidao', async () => {
    const resultado = await checar(
      (_requisicao, resposta) => {
        setTimeout(() => {
          resposta.writeHead(500);
          resposta.end('quebrou');
        }, 250);
      },
      { latencia_maxima_ms: 50 },
    );

    expect(resultado.motivo_falha).toBe('status');
  });
});

describe('assertivas de conteudo', () => {
  const respondeJson: Manipulador = (_requisicao, resposta) => {
    resposta.writeHead(200, { 'content-type': 'application/json', 'x-versao': '2.1.0' });
    resposta.end(JSON.stringify({ situacao: 'ok', banco: { conectado: true, latencia: 4 } }));
  };

  it('aprova texto presente no corpo', async () => {
    const resultado = await checar(respondeOk, {
      assertivas: [{ tipo: 'corpo_contem', valor: 'tudo certo' }],
    });

    expect(resultado.sucesso).toBe(true);
  });

  it('reprova quando o status esta certo mas o conteudo nao', async () => {
    const resultado = await checar(respondeOk, {
      assertivas: [{ tipo: 'corpo_contem', valor: 'banco conectado' }],
    });

    expect(resultado).toMatchObject({
      sucesso: false,
      codigo_http: 200,
      motivo_falha: 'assertiva',
    });
    expect(resultado.detalhe).toMatch(/nao contem "banco conectado"/);
  });

  it('reprova quando o corpo contem o que nao deveria', async () => {
    const resultado = await checar(respondeOk, {
      assertivas: [{ tipo: 'corpo_nao_contem', valor: 'certo' }],
    });

    expect(resultado.motivo_falha).toBe('assertiva');
  });

  it('casa expressao regular', async () => {
    const resultado = await checar(respondeOk, {
      assertivas: [{ tipo: 'corpo_regex', valor: '^tudo\\s+certo$' }],
    });

    expect(resultado.sucesso).toBe(true);
  });

  it('navega no json ate um campo aninhado', async () => {
    const resultado = await checar(respondeJson, {
      assertivas: [
        { tipo: 'json_igual', caminho: 'situacao', valor: 'ok' },
        { tipo: 'json_igual', caminho: 'banco.conectado', valor: true },
        { tipo: 'json_existe', caminho: 'banco.latencia' },
      ],
    });

    expect(resultado.sucesso).toBe(true);
  });

  it('diz o que veio quando o json diverge', async () => {
    const resultado = await checar(respondeJson, {
      assertivas: [{ tipo: 'json_igual', caminho: 'banco.conectado', valor: false }],
    });

    expect(resultado.detalhe).toMatch(/banco\.conectado veio true, esperava false/);
  });

  it('reprova caminho que nao existe', async () => {
    const resultado = await checar(respondeJson, {
      assertivas: [{ tipo: 'json_existe', caminho: 'fila.tamanho' }],
    });

    expect(resultado.detalhe).toMatch(/fila\.tamanho nao existe/);
  });

  it('compara cabecalho da resposta', async () => {
    const aprovado = await checar(respondeJson, {
      assertivas: [{ tipo: 'cabecalho_igual', nome: 'X-Versao', valor: '2.1.0' }],
    });
    expect(aprovado.sucesso).toBe(true);

    const reprovado = await checar(respondeJson, {
      assertivas: [{ tipo: 'cabecalho_igual', nome: 'X-Versao', valor: '3.0.0' }],
    });
    expect(reprovado.detalhe).toMatch(/veio "2\.1\.0"/);
  });

  it('le o corpo mesmo quando vem comprimido', async () => {
    const resultado = await checar(
      (_requisicao, resposta) => {
        resposta.writeHead(200, { 'content-encoding': 'gzip' });
        resposta.end(gzipSync('resposta comprimida'));
      },
      { assertivas: [{ tipo: 'corpo_contem', valor: 'resposta comprimida' }] },
    );

    expect(resultado.sucesso).toBe(true);
  });

  it('corta corpo gigante e avisa que cortou', async () => {
    const resultado = await checar(
      (_requisicao, resposta) => {
        resposta.writeHead(200);
        resposta.write('x'.repeat(2 * 1024 * 1024));
        resposta.end('marcador-do-fim');
      },
      { assertivas: [{ tipo: 'corpo_contem', valor: 'marcador-do-fim' }] },
    );

    expect(resultado.motivo_falha).toBe('assertiva');
    expect(resultado.detalhe).toMatch(/corpo foi cortado/);
  });
});

describe('metodo e corpo da requisicao', () => {
  it('envia o corpo no POST', async () => {
    let recebido = '';

    const resultado = await checar(
      (requisicao, resposta) => {
        const pedacos: Buffer[] = [];
        requisicao.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
        requisicao.on('end', () => {
          recebido = Buffer.concat(pedacos).toString('utf8');
          resposta.writeHead(200);
          resposta.end('recebi');
        });
      },
      {
        metodo: 'POST',
        corpo: JSON.stringify({ ping: true }),
        cabecalhos: { 'Content-Type': 'application/json' },
      },
    );

    expect(resultado.sucesso).toBe(true);
    expect(recebido).toBe('{"ping":true}');
  });

  it('manda o cabecalho configurado no monitor', async () => {
    let autorizacao: string | undefined;

    const resultado = await checar(
      (requisicao, resposta) => {
        autorizacao = requisicao.headers.authorization;
        resposta.writeHead(200);
        resposta.end('ok');
      },
      { cabecalhos: { Authorization: 'Bearer token-do-alvo' } },
    );

    expect(resultado.sucesso).toBe(true);
    expect(autorizacao).toBe('Bearer token-do-alvo');
  });
});

describe('redirecionamento', () => {
  it('segue ate a resposta final', async () => {
    const resultado = await checar(
      (requisicao, resposta) => {
        if (requisicao.url === '/saude') {
          resposta.writeHead(302, { location: '/saude/v2' });
          resposta.end();
          return;
        }
        resposta.writeHead(200);
        resposta.end('cheguei');
      },
      { assertivas: [{ tipo: 'corpo_contem', valor: 'cheguei' }] },
    );

    expect(resultado.sucesso).toBe(true);
  });

  it('recusa redirecionamento para a rede interna', async () => {
    const resultado = await checar((_requisicao, resposta) => {
      resposta.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      resposta.end();
    });

    expect(resultado).toMatchObject({ sucesso: false, motivo_falha: 'bloqueado' });
    expect(resultado.detalhe).toMatch(/rede interna/i);
  });

  it('desiste depois de redirecionar demais', async () => {
    const resultado = await checar((requisicao, resposta) => {
      const passo = Number(requisicao.url?.split('=')[1] ?? '0');
      resposta.writeHead(302, { location: `/volta?passo=${passo + 1}` });
      resposta.end();
    });

    expect(resultado).toMatchObject({ sucesso: false, motivo_falha: 'conexao' });
    expect(resultado.detalhe).toMatch(/redirecionamentos/);
  });

  it('troca POST por GET num 303', async () => {
    let metodoFinal = '';

    const resultado = await checar(
      (requisicao, resposta) => {
        if (requisicao.url === '/saude') {
          requisicao.resume();
          resposta.writeHead(303, { location: '/resultado' });
          resposta.end();
          return;
        }
        metodoFinal = requisicao.method ?? '';
        resposta.writeHead(200);
        resposta.end('ok');
      },
      { metodo: 'POST', corpo: '{"a":1}' },
    );

    expect(resultado.sucesso).toBe(true);
    expect(metodoFinal).toBe('GET');
  });

  it('nao leva a credencial junto ao mudar de host', async () => {
    let autorizacaoNoDestino: string | undefined = 'ainda-nao-chamado';

    const destino = await subirServidor((requisicao, resposta) => {
      autorizacaoNoDestino = requisicao.headers.authorization;
      resposta.writeHead(200);
      resposta.end('destino');
    });
    paraFechar.push(destino.fechar);

    const origem = await subirServidor((_requisicao, resposta) => {
      resposta.writeHead(302, { location: `http://localhost:${destino.porta}/destino` });
      resposta.end();
    });
    paraFechar.push(origem.fechar);

    const resultado = await executarCheck(
      monitorBase(origem.porta, { cabecalhos: { Authorization: 'Bearer segredo' } }),
      { resolverEndereco: resolverParaLoopback },
    );

    expect(resultado.sucesso).toBe(true);
    expect(autorizacaoNoDestino).toBeUndefined();
  });
});
