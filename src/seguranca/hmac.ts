import { createHmac, timingSafeEqual } from 'node:crypto';

export function assinar(corpo: string, segredo: string): string {
  return createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex');
}

export function assinaturaConfere(corpo: string, segredo: string, recebida: string): boolean {
  const esperada = Buffer.from(assinar(corpo, segredo), 'utf8');
  const informada = Buffer.from(recebida, 'utf8');

  if (esperada.length !== informada.length) return false;
  return timingSafeEqual(esperada, informada);
}
