import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { config } from '../config.ts';

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_DO_IV = 12;
const TAMANHO_DA_TAG = 16;

const chave = Buffer.from(config.CHAVE_CIFRA, 'hex');

/**
 * Cabecalhos de monitor costumam carregar token de API. Guardar em texto puro
 * significa que um dump do banco entrega as credenciais dos alvos monitorados.
 */
export function cifrar(texto: string): string {
  const iv = randomBytes(TAMANHO_DO_IV);
  const cifrador = createCipheriv(ALGORITMO, chave, iv);
  const conteudo = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);

  return Buffer.concat([iv, cifrador.getAuthTag(), conteudo]).toString('base64');
}

export function decifrar(pacote: string): string {
  const bruto = Buffer.from(pacote, 'base64');
  if (bruto.length <= TAMANHO_DO_IV + TAMANHO_DA_TAG) {
    throw new Error('Pacote cifrado tem tamanho invalido.');
  }

  const iv = bruto.subarray(0, TAMANHO_DO_IV);
  const tag = bruto.subarray(TAMANHO_DO_IV, TAMANHO_DO_IV + TAMANHO_DA_TAG);
  const conteudo = bruto.subarray(TAMANHO_DO_IV + TAMANHO_DA_TAG);

  const decifrador = createDecipheriv(ALGORITMO, chave, iv);
  decifrador.setAuthTag(tag);

  return Buffer.concat([decifrador.update(conteudo), decifrador.final()]).toString('utf8');
}
