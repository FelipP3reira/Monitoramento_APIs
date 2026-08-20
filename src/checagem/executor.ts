import {
  request as requisitarHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import { request as requisitarHttps } from 'node:https';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import type { MetodoHttp, MotivoDeFalha } from '../db/tipos.ts';
import type { Assertiva } from '../dominio/assertivas.ts';
import {
  DestinoBloqueado,
  resolverEnderecoSeguro,
  validarUrlDeMonitor,
  type EnderecoResolvido,
} from '../seguranca/rede.ts';

import { avaliarAssertivas } from './avaliador.ts';

const LIMITE_DO_CORPO = 1024 * 1024;
const MAXIMO_DE_REDIRECIONAMENTOS = 3;
const AGENTE = 'Monitoramento-APIs/0.1';

const REDIRECIONAMENTOS = new Set([301, 302, 303, 307, 308]);

// Trocar de host num redirecionamento e trocar de destinatario: o token do alvo
// original nao pode viajar junto.
const CABECALHOS_DE_CREDENCIAL = new Set(['authorization', 'cookie', 'proxy-authorization']);

export class FalhaDeCheck extends Error {
  readonly motivo: MotivoDeFalha;

  constructor(motivo: MotivoDeFalha, mensagem: string) {
    super(mensagem);
    this.name = 'FalhaDeCheck';
    this.motivo = motivo;
  }
}

export interface MonitorParaCheck {
  url: string;
  metodo: MetodoHttp;
  cabecalhos: Record<string, string>;
  corpo: string | null;
  timeout_ms: number;
  status_esperado: number[];
  latencia_maxima_ms: number | null;
  assertivas: Assertiva[];
}

export interface ResultadoDoCheck {
  sucesso: boolean;
  codigo_http: number | null;
  latencia_ms: number;
  motivo_falha: MotivoDeFalha | null;
  detalhe: string | null;
}

export interface DependenciasDoExecutor {
  /**
   * Trocavel so para o teste conseguir apontar para um servidor local: em
   * producao a resolucao segura e o padrao, e e ela que barra rebinding de DNS
   * entre o cadastro e o check.
   */
  resolverEndereco?: (anfitriao: string) => Promise<EnderecoResolvido>;
}

interface Pedido {
  metodo: MetodoHttp;
  corpo: string | null;
  cabecalhos: Record<string, string>;
}

interface RespostaBruta {
  status: number;
  cabecalhos: Record<string, string>;
  corpo: string;
  corpoTruncado: boolean;
  local: string | undefined;
}

function normalizarCabecalhos(recebidos: IncomingHttpHeaders): Record<string, string> {
  const normalizados: Record<string, string> = {};

  for (const [nome, valor] of Object.entries(recebidos)) {
    if (valor === undefined) continue;
    normalizados[nome.toLowerCase()] = Array.isArray(valor) ? valor.join(', ') : valor;
  }

  return normalizados;
}

function descomprimir(resposta: IncomingMessage): Readable {
  switch ((resposta.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
      return resposta.pipe(createGunzip());
    case 'deflate':
      return resposta.pipe(createInflate());
    case 'br':
      return resposta.pipe(createBrotliDecompress());
    default:
      return resposta;
  }
}

/**
 * O corte vale depois de descomprimir, nao antes: um megabyte de gzip vira
 * gigabytes na memoria do worker se ninguem estiver contando.
 */
async function lerCorpo(resposta: IncomingMessage): Promise<{ corpo: string; truncado: boolean }> {
  const pedacos: Buffer[] = [];
  let lidos = 0;
  let truncado = false;

  for await (const pedaco of descomprimir(resposta)) {
    const bloco = pedaco as Buffer;
    const sobra = LIMITE_DO_CORPO - lidos;

    if (bloco.length >= sobra) {
      pedacos.push(bloco.subarray(0, sobra));
      truncado = true;
      break;
    }

    pedacos.push(bloco);
    lidos += bloco.length;
  }

  if (truncado) resposta.destroy();

  return { corpo: Buffer.concat(pedacos).toString('utf8'), truncado };
}

function requisitar(
  url: URL,
  destino: EnderecoResolvido,
  pedido: Pedido,
  prazoFinal: number,
): Promise<RespostaBruta> {
  return new Promise((resolver, rejeitar) => {
    const restante = prazoFinal - performance.now();
    if (restante <= 0) {
      rejeitar(new FalhaDeCheck('timeout', 'o tempo acabou antes de abrir a conexao'));
      return;
    }

    const ehHttps = url.protocol === 'https:';
    const portaPadrao = ehHttps ? 443 : 80;
    const porta = url.port === '' ? portaPadrao : Number(url.port);
    const anfitriao = url.hostname.replace(/^\[|\]$/g, '');

    const cabecalhos: Record<string, string> = {
      // A conexao vai para o IP ja conferido; o Host preserva o nome para o alvo.
      Host: porta === portaPadrao ? anfitriao : `${anfitriao}:${porta}`,
      'User-Agent': AGENTE,
      'Accept-Encoding': 'identity',
      ...pedido.cabecalhos,
    };

    if (pedido.corpo !== null) {
      cabecalhos['Content-Length'] = String(Buffer.byteLength(pedido.corpo));
    }

    const requisicao = (ehHttps ? requisitarHttps : requisitarHttp)({
      host: destino.endereco,
      port: porta,
      path: `${url.pathname}${url.search}`,
      method: pedido.metodo,
      headers: cabecalhos,
      family: destino.familia,
      // O certificado continua sendo conferido contra o nome, nao contra o IP.
      ...(ehHttps ? { servername: anfitriao } : {}),
    });

    const relogio = setTimeout(() => {
      requisicao.destroy(new FalhaDeCheck('timeout', 'o alvo nao respondeu dentro do tempo'));
    }, restante);

    const encerrar = (): void => clearTimeout(relogio);

    requisicao.on('error', (erro: Error) => {
      encerrar();
      rejeitar(erro instanceof FalhaDeCheck ? erro : new FalhaDeCheck('conexao', erro.message));
    });

    requisicao.on('response', (resposta: IncomingMessage) => {
      const status = resposta.statusCode ?? 0;
      const cabecalhosRecebidos = normalizarCabecalhos(resposta.headers);

      if (REDIRECIONAMENTOS.has(status)) {
        resposta.resume();
        encerrar();
        resolver({
          status,
          cabecalhos: cabecalhosRecebidos,
          corpo: '',
          corpoTruncado: false,
          local: resposta.headers.location,
        });
        return;
      }

      lerCorpo(resposta).then(
        ({ corpo, truncado }) => {
          encerrar();
          resolver({
            status,
            cabecalhos: cabecalhosRecebidos,
            corpo,
            corpoTruncado: truncado,
            local: undefined,
          });
        },
        (erro: Error) => {
          encerrar();
          rejeitar(new FalhaDeCheck('conexao', `falha ao ler a resposta: ${erro.message}`));
        },
      );
    });

    if (pedido.corpo !== null) requisicao.write(pedido.corpo);
    requisicao.end();
  });
}

function ajustarParaRedirecionamento(
  status: number,
  pedido: Pedido,
  trocouDeHost: boolean,
): Pedido {
  const cabecalhos = trocouDeHost
    ? Object.fromEntries(
        Object.entries(pedido.cabecalhos).filter(
          ([nome]) => !CABECALHOS_DE_CREDENCIAL.has(nome.toLowerCase()),
        ),
      )
    : pedido.cabecalhos;

  const viraGet = status === 303 || ((status === 301 || status === 302) && pedido.metodo !== 'GET');

  return viraGet
    ? { metodo: 'GET', corpo: null, cabecalhos }
    : { metodo: pedido.metodo, corpo: pedido.corpo, cabecalhos };
}

async function buscar(
  urlInicial: URL,
  monitor: MonitorParaCheck,
  resolverEndereco: (anfitriao: string) => Promise<EnderecoResolvido>,
  prazoFinal: number,
): Promise<RespostaBruta> {
  let url = urlInicial;
  let pedido: Pedido = {
    metodo: monitor.metodo,
    corpo: monitor.corpo,
    cabecalhos: monitor.cabecalhos,
  };

  for (let salto = 0; salto <= MAXIMO_DE_REDIRECIONAMENTOS; salto += 1) {
    // Cada salto passa pela guarda de novo: sem isso, o alvo redireciona para um
    // IP interno e a conferencia da primeira URL nao vale nada.
    const destino = await resolverEndereco(url.hostname.replace(/^\[|\]$/g, ''));
    const resposta = await requisitar(url, destino, pedido, prazoFinal);

    if (!REDIRECIONAMENTOS.has(resposta.status) || resposta.local === undefined) {
      return resposta;
    }

    let proxima: URL;
    try {
      proxima = validarUrlDeMonitor(new URL(resposta.local, url).toString());
    } catch (erro) {
      if (erro instanceof DestinoBloqueado) throw erro;
      throw new FalhaDeCheck('conexao', `redirecionamento invalido para "${resposta.local}"`);
    }

    pedido = ajustarParaRedirecionamento(resposta.status, pedido, proxima.host !== url.host);
    url = proxima;
  }

  throw new FalhaDeCheck('conexao', `passou de ${MAXIMO_DE_REDIRECIONAMENTOS} redirecionamentos`);
}

/**
 * Ordem de julgamento: status, depois conteudo, depois latencia. Uma resposta com
 * status errado nao tem conteudo confiavel para checar, e dizer "esta lento"
 * quando na verdade veio 500 manda o plantao para o lado errado.
 */
export async function executarCheck(
  monitor: MonitorParaCheck,
  dependencias: DependenciasDoExecutor = {},
): Promise<ResultadoDoCheck> {
  const resolverEndereco = dependencias.resolverEndereco ?? resolverEnderecoSeguro;
  const inicio = performance.now();

  try {
    const url = validarUrlDeMonitor(monitor.url);
    const resposta = await buscar(url, monitor, resolverEndereco, inicio + monitor.timeout_ms);
    const latencia = Math.round(performance.now() - inicio);

    if (!monitor.status_esperado.includes(resposta.status)) {
      return {
        sucesso: false,
        codigo_http: resposta.status,
        latencia_ms: latencia,
        motivo_falha: 'status',
        detalhe: `respondeu ${resposta.status}, esperava ${monitor.status_esperado.join(' ou ')}`,
      };
    }

    const veredito = avaliarAssertivas(monitor.assertivas, {
      corpo: resposta.corpo,
      corpoTruncado: resposta.corpoTruncado,
      cabecalhos: resposta.cabecalhos,
    });

    if (!veredito.ok) {
      return {
        sucesso: false,
        codigo_http: resposta.status,
        latencia_ms: latencia,
        motivo_falha: 'assertiva',
        detalhe: veredito.detalhe,
      };
    }

    if (monitor.latencia_maxima_ms !== null && latencia > monitor.latencia_maxima_ms) {
      return {
        sucesso: false,
        codigo_http: resposta.status,
        latencia_ms: latencia,
        motivo_falha: 'latencia',
        detalhe: `levou ${latencia}ms, o limite e ${monitor.latencia_maxima_ms}ms`,
      };
    }

    return {
      sucesso: true,
      codigo_http: resposta.status,
      latencia_ms: latencia,
      motivo_falha: null,
      detalhe: null,
    };
  } catch (erro) {
    const latencia = Math.round(performance.now() - inicio);

    if (erro instanceof DestinoBloqueado) {
      return {
        sucesso: false,
        codigo_http: null,
        latencia_ms: latencia,
        motivo_falha: 'bloqueado',
        detalhe: erro.message,
      };
    }

    if (erro instanceof FalhaDeCheck) {
      return {
        sucesso: false,
        codigo_http: null,
        latencia_ms: latencia,
        motivo_falha: erro.motivo,
        detalhe: erro.message,
      };
    }

    return {
      sucesso: false,
      codigo_http: null,
      latencia_ms: latencia,
      motivo_falha: 'conexao',
      detalhe: erro instanceof Error ? erro.message : 'falha desconhecida',
    };
  }
}
