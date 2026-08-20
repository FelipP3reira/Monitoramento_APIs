import { assinar } from '../seguranca/hmac.ts';

import type { ClienteHttp } from './cliente-http.ts';
import { FalhaDeEntrega, resumirAlerta, type Alerta, type Canal } from './tipos.ts';

/**
 * 408 e 429 sao os dois codigos da familia 4xx que pedem para tentar de novo:
 * o primeiro diz que a requisicao demorou, o segundo que foi rapido demais.
 */
const QUATRO_CENTOS_QUE_VALEM_REENVIO = new Set([408, 429]);

function montarCorpo(alerta: Alerta): string {
  return JSON.stringify({
    evento: alerta.evento,
    resumo: resumirAlerta(alerta),
    incidente_id: alerta.incidenteId,
    monitor: { nome: alerta.monitorNome, url: alerta.monitorUrl },
    motivo: alerta.motivo,
    detalhe: alerta.detalhe,
    aberto_em: alerta.abertoEm.toISOString(),
    fechado_em: alerta.fechadoEm?.toISOString() ?? null,
    duracao_segundos: alerta.duracaoSegundos,
  });
}

export class CanalDeWebhook implements Canal {
  readonly tipo = 'webhook' as const;

  constructor(private readonly cliente: ClienteHttp) {}

  async enviar(alerta: Alerta, destino: string, segredo: string | null): Promise<void> {
    const corpo = montarCorpo(alerta);
    const cabecalhos: Record<string, string> = {
      'X-Monitoramento-Evento': alerta.evento,
      'X-Monitoramento-Incidente': alerta.incidenteId,
    };

    // Assinatura sobre o corpo exato que vai no fio: quem recebe consegue
    // confirmar que o aviso saiu daqui e nao foi alterado no caminho.
    if (segredo !== null) {
      cabecalhos['X-Monitoramento-Assinatura'] = `sha256=${assinar(corpo, segredo)}`;
    }

    let status: number;
    try {
      ({ status } = await this.cliente.postar(destino, corpo, cabecalhos));
    } catch (erro) {
      throw new FalhaDeEntrega(erro instanceof Error ? erro.message : 'falha de rede', false);
    }

    if (status >= 200 && status < 300) return;

    const permanente =
      status >= 400 && status < 500 && !QUATRO_CENTOS_QUE_VALEM_REENVIO.has(status);

    throw new FalhaDeEntrega(`o webhook respondeu ${status}`, permanente);
  }
}
