import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { BancoDeDados } from '../db/conexao.ts';
import { criarCanal, listarCanais, removerCanal } from '../dominio/repositorio-canais.ts';
import { DestinoBloqueado, validarUrlDeMonitor } from '../seguranca/rede.ts';

const esquemaDoIdentificador = z.object({ id: z.string().uuid() });

const esquemaDoCanal = z
  .object({
    monitor_id: z.string().uuid().nullable().default(null),
    tipo: z.enum(['email', 'webhook']),
    destino: z.string().min(1).max(2000),
    segredo: z.string().min(16).max(200).optional(),
    ativo: z.boolean().default(true),
  })
  .superRefine((canal, contexto) => {
    if (canal.tipo === 'email') {
      if (!z.string().email().safeParse(canal.destino).success) {
        contexto.addIssue({ code: 'custom', path: ['destino'], message: 'E-mail invalido.' });
      }
      return;
    }

    // O endereco do webhook passa pela mesma guarda dos monitores: senao o
    // cadastro de canal viraria a porta dos fundos do SSRF.
    try {
      validarUrlDeMonitor(canal.destino);
    } catch (erro) {
      contexto.addIssue({
        code: 'custom',
        path: ['destino'],
        message: erro instanceof DestinoBloqueado ? erro.message : 'URL invalida.',
      });
    }
  });

export function rotasDeCanais(db: BancoDeDados, limiteDeEscrita: number): FastifyPluginCallback {
  const limitarEscrita = {
    config: { rateLimit: { max: limiteDeEscrita, timeWindow: '1 minute' } },
  };

  return (app, _opcoes, pronto) => {
    app.post('/canais', limitarEscrita, async (requisicao, resposta) => {
      const dados = esquemaDoCanal.parse(requisicao.body);
      return resposta.code(201).send(await criarCanal(db, dados));
    });

    app.get('/canais', () => listarCanais(db));

    app.delete('/canais/:id', limitarEscrita, async (requisicao, resposta) => {
      const { id } = esquemaDoIdentificador.parse(requisicao.params);

      if (!(await removerCanal(db, id))) {
        return resposta.code(404).send({ erro: 'Canal nao encontrado.' });
      }

      return resposta.code(204).send();
    });

    pronto();
  };
}
