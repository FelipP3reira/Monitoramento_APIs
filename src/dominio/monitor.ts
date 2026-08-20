import { z } from 'zod';

import { DestinoBloqueado, validarUrlDeMonitor } from '../seguranca/rede.ts';

import { esquemaDaAssertiva } from './assertivas.ts';

const NOME_DE_CABECALHO = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

// Quem controla o tamanho do corpo e o transporte e o executor, nao o usuario:
// deixar esses cabecalhos passarem abre porta para request smuggling.
const CABECALHOS_RESERVADOS = new Set(['content-length', 'connection', 'transfer-encoding']);

const esquemaDosCabecalhos = z
  .record(z.string(), z.string().max(2000))
  .refine((cabecalhos) => Object.keys(cabecalhos).length <= 20, {
    message: 'No maximo 20 cabecalhos por monitor.',
  })
  .superRefine((cabecalhos, contexto) => {
    for (const [nome, valor] of Object.entries(cabecalhos)) {
      if (!NOME_DE_CABECALHO.test(nome)) {
        contexto.addIssue({ code: 'custom', message: `Nome de cabecalho invalido: ${nome}` });
      }
      if (CABECALHOS_RESERVADOS.has(nome.toLowerCase())) {
        contexto.addIssue({
          code: 'custom',
          message: `O cabecalho ${nome} e controlado pelo monitor.`,
        });
      }
      // Quebra de linha no valor permite injetar cabecalho novo na requisicao.
      if (/[\r\n]/.test(valor)) {
        contexto.addIssue({ code: 'custom', message: `O cabecalho ${nome} tem quebra de linha.` });
      }
    }
  });

const urlDeMonitor = z
  .string()
  .max(2000)
  .superRefine((bruta, contexto) => {
    try {
      validarUrlDeMonitor(bruta);
    } catch (erro) {
      contexto.addIssue({
        code: 'custom',
        message: erro instanceof DestinoBloqueado ? erro.message : 'URL invalida.',
      });
    }
  });

const campos = {
  nome: z.string().min(1).max(120),
  url: urlDeMonitor,
  metodo: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  cabecalhos: esquemaDosCabecalhos,
  corpo: z.string().max(10_000),
  intervalo_segundos: z.number().int().min(10).max(86_400),
  timeout_ms: z.number().int().min(100).max(60_000),
  status_esperado: z.array(z.number().int().min(100).max(599)).min(1).max(10),
  latencia_maxima_ms: z.number().int().min(1).max(60_000).nullable(),
  assertivas: z.array(esquemaDaAssertiva).max(10),
  falhas_para_abrir: z.number().int().min(1).max(20),
  sucessos_para_fechar: z.number().int().min(1).max(20),
  ativo: z.boolean(),
};

export const esquemaDeCriacao = z.object({
  ...campos,
  metodo: campos.metodo.default('GET'),
  cabecalhos: campos.cabecalhos.optional(),
  corpo: campos.corpo.optional(),
  timeout_ms: campos.timeout_ms.default(5_000),
  status_esperado: campos.status_esperado.default([200]),
  latencia_maxima_ms: campos.latencia_maxima_ms.default(null),
  assertivas: campos.assertivas.default([]),
  falhas_para_abrir: campos.falhas_para_abrir.default(3),
  sucessos_para_fechar: campos.sucessos_para_fechar.default(2),
  ativo: campos.ativo.default(true),
});

/**
 * A atualizacao usa os campos crus, sem os default do cadastro. Nao e detalhe:
 * partial() do zod mantem o default, entao um PATCH vazio devolveria o objeto
 * inteiro preenchido e sobrescreveria metodo, timeout e limiares do monitor.
 */
export const esquemaDeAtualizacao = z
  .object(campos)
  .partial()
  .refine((enviados) => Object.keys(enviados).length > 0, {
    message: 'Envie pelo menos um campo para atualizar.',
  });

export type DadosDeCriacao = z.infer<typeof esquemaDeCriacao>;
export type DadosDeAtualizacao = z.infer<typeof esquemaDeAtualizacao>;
