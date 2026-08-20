import { existsSync } from 'node:fs';
import { join } from 'node:path';

import helmet from '@fastify/helmet';
import limitadorDeTaxa from '@fastify/rate-limit';
import arquivosEstaticos from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { config } from './config.ts';
import type { BancoDeDados } from './db/conexao.ts';
import { rotasDeCanais } from './rotas/canais.ts';
import { rotasDeIncidentes } from './rotas/incidentes.ts';
import { rotasDeMonitores } from './rotas/monitores.ts';
import { rotasDeUptime } from './rotas/uptime.ts';
import { exigirToken } from './seguranca/autenticacao.ts';
import { DestinoBloqueado } from './seguranca/rede.ts';

export interface OpcoesDoApp {
  db: BancoDeDados;
  limiteGlobal?: number;
  limiteDeEscrita?: number;
}

export async function montarApp({
  db,
  limiteGlobal = 240,
  limiteDeEscrita = 30,
}: OpcoesDoApp): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.AMBIENTE !== 'teste',
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(limitadorDeTaxa, { max: limiteGlobal, timeWindow: '1 minute' });

  app.setErrorHandler((erro: FastifyError, _requisicao, resposta) => {
    if (erro instanceof ZodError) {
      return resposta.code(400).send({
        erro: 'Dados invalidos.',
        problemas: erro.issues.map((problema) => ({
          campo: problema.path.join('.'),
          mensagem: problema.message,
        })),
      });
    }

    if (erro instanceof DestinoBloqueado) {
      return resposta.code(400).send({ erro: erro.message });
    }

    app.log.error({ erro }, 'Falha nao tratada');
    return resposta
      .code(erro.statusCode ?? 500)
      .send({ erro: 'Nao consegui processar a chamada.' });
  });

  app.get('/saude', () => ({ situacao: 'ok' }));

  await app.register(
    async (rotasProtegidas) => {
      rotasProtegidas.addHook('onRequest', exigirToken);
      await rotasProtegidas.register(rotasDeMonitores(db, limiteDeEscrita));
      await rotasProtegidas.register(rotasDeIncidentes(db));
      await rotasProtegidas.register(rotasDeUptime(db));
      await rotasProtegidas.register(rotasDeCanais(db, limiteDeEscrita));
    },
    { prefix: '/api' },
  );

  // O painel so e servido se tiver sido construido; em desenvolvimento ele roda
  // no Vite, com proxy para esta mesma API.
  const pastaDoPainel = join(import.meta.dirname, '..', 'web', 'dist');
  if (existsSync(join(pastaDoPainel, 'index.html'))) {
    await app.register(arquivosEstaticos, { root: pastaDoPainel });
  }

  return app;
}
