import { request as requisitarHttp } from 'node:http';
import { request as requisitarHttps } from 'node:https';

import { resolverEnderecoSeguro, validarUrlDeMonitor } from '../seguranca/rede.ts';

const TIMEOUT_MS = 10_000;

export interface ClienteHttp {
  postar: (
    url: string,
    corpo: string,
    cabecalhos: Record<string, string>,
  ) => Promise<{ status: number }>;
}

/**
 * O endereco do webhook tambem vem do usuario, entao passa pela mesma guarda dos
 * monitores. Sem isso o cadastro de canal viraria a porta dos fundos do SSRF que
 * a rota de monitor fecha na frente.
 *
 * Redirecionamento nao e seguido de proposito: webhook que responde 302 esta
 * configurado errado, e seguir seria mais uma chance de acabar em rede interna.
 */
export class ClienteHttpSeguro implements ClienteHttp {
  async postar(
    url: string,
    corpo: string,
    cabecalhos: Record<string, string>,
  ): Promise<{ status: number }> {
    const destino = validarUrlDeMonitor(url);
    const endereco = await resolverEnderecoSeguro(destino.hostname.replace(/^\[|\]$/g, ''));

    return new Promise((resolver, rejeitar) => {
      const ehHttps = destino.protocol === 'https:';
      const portaPadrao = ehHttps ? 443 : 80;
      const porta = destino.port === '' ? portaPadrao : Number(destino.port);
      const anfitriao = destino.hostname.replace(/^\[|\]$/g, '');

      const requisicao = (ehHttps ? requisitarHttps : requisitarHttp)({
        host: endereco.endereco,
        port: porta,
        path: `${destino.pathname}${destino.search}`,
        method: 'POST',
        family: endereco.familia,
        headers: {
          Host: porta === portaPadrao ? anfitriao : `${anfitriao}:${porta}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(corpo)),
          ...cabecalhos,
        },
        ...(ehHttps ? { servername: anfitriao } : {}),
      });

      const relogio = setTimeout(() => {
        requisicao.destroy(new Error('o webhook nao respondeu dentro do tempo'));
      }, TIMEOUT_MS);

      requisicao.on('error', (erro: Error) => {
        clearTimeout(relogio);
        rejeitar(erro);
      });

      requisicao.on('response', (resposta) => {
        clearTimeout(relogio);
        // O corpo da resposta nao interessa, mas precisa ser drenado para o
        // socket fechar em vez de ficar preso ate o timeout.
        resposta.resume();
        resolver({ status: resposta.statusCode ?? 0 });
      });

      requisicao.end(corpo);
    });
  }
}
