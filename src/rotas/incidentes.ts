import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { BancoDeDados } from '../db/conexao.ts';
import { buscarMonitor } from '../dominio/repositorio-monitores.ts';
import { listarIncidentes } from '../dominio/repositorio-incidentes.ts';

const esquemaDoIdentificador = z.object({ id: z.string().uuid() });
const esquemaDaConsulta = z.object({ limite: z.coerce.number().int().min(1).max(200).default(50) });

export function rotasDeIncidentes(db: BancoDeDados): FastifyPluginCallback {
  return (app, _opcoes, pronto) => {
    app.get('/monitores/:id/incidentes', async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const { limite } = esquemaDaConsulta.parse(requisicao.query);

      if ((await buscarMonitor(db, id)) === undefined) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }

      return listarIncidentes(db, id, limite);
    });

    pronto();
  };
}
