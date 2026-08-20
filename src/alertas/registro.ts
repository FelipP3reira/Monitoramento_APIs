import { ClienteHttpSeguro } from './cliente-http.ts';
import { CanalDeEmail } from './canal-email.ts';
import { CanalDeWebhook } from './canal-webhook.ts';
import type { Canal } from './tipos.ts';
import { criarTransporteDeEmail } from './transporte-email.ts';

export class RegistroDeCanais {
  private readonly porTipo: Map<string, Canal>;

  constructor(canais: Canal[]) {
    this.porTipo = new Map(canais.map((canal) => [canal.tipo, canal]));
  }

  buscar(tipo: string): Canal | undefined {
    return this.porTipo.get(tipo);
  }
}

export function registroPadrao(): RegistroDeCanais {
  return new RegistroDeCanais([
    new CanalDeEmail(criarTransporteDeEmail()),
    new CanalDeWebhook(new ClienteHttpSeguro()),
  ]);
}
