import { z } from 'zod';

// Padrao do usuario roda contra corpo de resposta arbitrario, entao o tamanho e
// limitado aqui e a avaliacao recorta o corpo antes de aplicar (ver avaliador).
const LIMITE_DO_PADRAO = 200;

export const esquemaDaAssertiva = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('corpo_contem'), valor: z.string().min(1).max(500) }),
  z.object({ tipo: z.literal('corpo_nao_contem'), valor: z.string().min(1).max(500) }),
  z.object({ tipo: z.literal('corpo_regex'), valor: z.string().min(1).max(LIMITE_DO_PADRAO) }),
  z.object({
    tipo: z.literal('json_igual'),
    caminho: z.string().min(1).max(200),
    valor: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({ tipo: z.literal('json_existe'), caminho: z.string().min(1).max(200) }),
  z.object({
    tipo: z.literal('cabecalho_igual'),
    nome: z.string().min(1).max(100),
    valor: z.string().max(500),
  }),
]);

export type Assertiva = z.infer<typeof esquemaDaAssertiva>;
