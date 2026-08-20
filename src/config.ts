import { z } from 'zod';

const esquemaDoAmbiente = z.object({
  DATABASE_URL: z.string().url(),
  PORTA: z.coerce.number().int().positive().default(3011),
  AMBIENTE: z.enum(['desenvolvimento', 'teste', 'producao']).default('desenvolvimento'),
  CHAVE_CIFRA: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CHAVE_CIFRA precisa ser 64 caracteres hexadecimais (32 bytes)'),
  LOTE_DO_WORKER: z.coerce.number().int().min(1).max(100).default(10),
  LEASE_SEGUNDOS: z.coerce.number().int().min(5).max(600).default(60),
  RETENCAO_DIAS: z.coerce.number().int().min(1).max(365).default(30),
  SMTP_HOST: z.string().optional(),
  SMTP_PORTA: z.coerce.number().int().positive().default(587),
  SMTP_USUARIO: z.string().optional(),
  SMTP_SENHA: z.string().optional(),
  EMAIL_REMETENTE: z.string().default('alertas@monitoramento.local'),
});

const lido = esquemaDoAmbiente.safeParse(process.env);

if (!lido.success) {
  const problemas = lido.error.issues
    .map((problema) => `  ${problema.path.join('.')}: ${problema.message}`)
    .join('\n');
  throw new Error(`Variaveis de ambiente invalidas:\n${problemas}`);
}

export const config = lido.data;
