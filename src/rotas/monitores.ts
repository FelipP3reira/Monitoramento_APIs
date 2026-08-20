import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { BancoDeDados } from '../db/conexao.ts';
import { esquemaDeAtualizacao, esquemaDeCriacao } from '../dominio/monitor.ts';
import {
  atualizarMonitor,
  buscarMonitor,
  criarMonitor,
  listarMonitores,
  removerMonitor,
} from '../dominio/repositorio-monitores.ts';

const esquemaDoIdentificador = z.object({ id: z.string().uuid() });

export function rotasDeMonitores(db: BancoDeDados, limiteDeEscrita: number): FastifyPluginCallback {
  const limitarEscrita = {
    config: { rateLimit: { max: limiteDeEscrita, timeWindow: '1 minute' } },
  };

  return (app, _opcoes, pronto) => {
    app.post('/monitores', limitarEscrita, async (requisicao, resposta) => {
      const dados = esquemaDeCriacao.parse(requisicao.body);
      const monitor = await criarMonitor(db, dados);
      return resposta.code(201).send(monitor);
    });

    app.get('/monitores', () => listarMonitores(db));

    app.get('/monitores/:id', async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const monitor = await buscarMonitor(db, id);

      if (monitor === undefined) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }
      return monitor;
    });

    app.patch('/monitores/:id', limitarEscrita, async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const dados = esquemaDeAtualizacao.parse(requisicao.body);
      const monitor = await atualizarMonitor(db, id, dados);

      if (monitor === undefined) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }
      return monitor;
    });

    app.delete('/monitores/:id', limitarEscrita, async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const removido = await removerMonitor(db, id);

      if (!removido) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }
      return resposta.code(204).send();
    });

    pronto();
  };
}
