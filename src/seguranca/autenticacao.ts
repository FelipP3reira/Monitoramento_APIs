import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.ts';

const tokenEsperado = Buffer.from(config.API_TOKEN, 'utf8');

function tokenConfere(recebido: string): boolean {
  const bytes = Buffer.from(recebido, 'utf8');
  // timingSafeEqual exige o mesmo tamanho, e a diferenca de tamanho ja e resposta.
  if (bytes.length !== tokenEsperado.length) return false;
  return timingSafeEqual(bytes, tokenEsperado);
}

// Precisa ser async: um hook sincrono que nao chama done deixa a requisicao
// pendurada para sempre quando o token e valido e nada e enviado.
export async function exigirToken(
  requisicao: FastifyRequest,
  resposta: FastifyReply,
): Promise<void> {
  const cabecalho = requisicao.headers.authorization ?? '';
  const [esquema, token] = cabecalho.split(' ');

  if (esquema !== 'Bearer' || token === undefined || !tokenConfere(token)) {
    await resposta.code(401).send({ erro: 'Token ausente ou invalido.' });
  }
}
