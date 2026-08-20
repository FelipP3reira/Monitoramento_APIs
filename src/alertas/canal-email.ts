import { FalhaDeEntrega, resumirAlerta, type Alerta, type Canal } from './tipos.ts';
import type { TransporteDeEmail } from './transporte-email.ts';

function montarCorpo(alerta: Alerta): string {
  const linhas = [
    resumirAlerta(alerta),
    '',
    `Monitor: ${alerta.monitorNome}`,
    `Endereco: ${alerta.monitorUrl}`,
    `Motivo: ${alerta.motivo}`,
  ];

  if (alerta.detalhe !== null) linhas.push(`Detalhe: ${alerta.detalhe}`);
  linhas.push(`Inicio: ${alerta.abertoEm.toISOString()}`);
  if (alerta.fechadoEm !== null) linhas.push(`Fim: ${alerta.fechadoEm.toISOString()}`);

  return linhas.join('\n');
}

export class CanalDeEmail implements Canal {
  readonly tipo = 'email' as const;

  constructor(private readonly transporte: TransporteDeEmail) {}

  async enviar(alerta: Alerta, destino: string): Promise<void> {
    try {
      await this.transporte.entregar({
        destino,
        assunto: resumirAlerta(alerta),
        corpo: montarCorpo(alerta),
      });
    } catch (erro) {
      // Servidor de e-mail fora do ar e problema passageiro; vale tentar de novo.
      throw new FalhaDeEntrega(erro instanceof Error ? erro.message : 'falha ao enviar', false);
    }
  }
}
