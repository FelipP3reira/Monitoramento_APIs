import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { BancoDeDados } from '../db/conexao.ts';
import { buscarMonitor } from '../dominio/repositorio-monitores.ts';
import { resumoDeUptime, serieHoraria } from '../dominio/repositorio-uptime.ts';

const MAXIMO_DE_HORAS = 90 * 24;

const esquemaDoIdentificador = z.object({ id: z.string().uuid() });
const esquemaDaJanela = z.object({
  horas: z.coerce.number().int().min(1).max(MAXIMO_DE_HORAS).default(24),
});

export function rotasDeUptime(db: BancoDeDados): FastifyPluginCallback {
  return (app, _opcoes, pronto) => {
    app.get('/monitores/:id/uptime', async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const { horas } = esquemaDaJanela.parse(requisicao.query);

      if ((await buscarMonitor(db, id)) === undefined) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }

      return resumoDeUptime(db, id, horas);
    });

    app.get('/monitores/:id/serie', async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);
      const { horas } = esquemaDaJanela.parse(requisicao.query);

      if ((await buscarMonitor(db, id)) === undefined) {
        return resposta.code(404).send({ erro: 'Monitor nao encontrado.' });
      }

      return serieHoraria(db, id, horas);
    });

    pronto();
  };
}
