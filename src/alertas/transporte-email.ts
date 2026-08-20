import { createTransport } from 'nodemailer';

import { config } from '../config.ts';

export interface MensagemDeEmail {
  destino: string;
  assunto: string;
  corpo: string;
}

export interface TransporteDeEmail {
  entregar: (mensagem: MensagemDeEmail) => Promise<void>;
}

/**
 * Sem SMTP configurado o alerta de e-mail nao vira erro: ele fica registrado em
 * memoria. Isso deixa a suite e a demonstracao rodarem sem depender de rede, e
 * deixa claro no log que o e-mail nao saiu de verdade.
 */
export class TransporteEmMemoria implements TransporteDeEmail {
  readonly enviadas: MensagemDeEmail[] = [];

  entregar(mensagem: MensagemDeEmail): Promise<void> {
    this.enviadas.push(mensagem);
    return Promise.resolve();
  }
}

class TransporteSmtp implements TransporteDeEmail {
  private readonly transporte = createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORTA,
    secure: config.SMTP_PORTA === 465,
    auth:
      config.SMTP_USUARIO === undefined
        ? undefined
        : { user: config.SMTP_USUARIO, pass: config.SMTP_SENHA },
  });

  async entregar(mensagem: MensagemDeEmail): Promise<void> {
    await this.transporte.sendMail({
      from: config.EMAIL_REMETENTE,
      to: mensagem.destino,
      subject: mensagem.assunto,
      text: mensagem.corpo,
    });
  }
}

export function criarTransporteDeEmail(): TransporteDeEmail {
  const host = config.SMTP_HOST ?? '';
  return host === '' ? new TransporteEmMemoria() : new TransporteSmtp();
}
