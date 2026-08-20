export type EventoDeAlerta = 'abriu' | 'fechou';

export interface Alerta {
  evento: EventoDeAlerta;
  incidenteId: string;
  monitorNome: string;
  monitorUrl: string;
  motivo: string;
  detalhe: string | null;
  abertoEm: Date;
  fechadoEm: Date | null;
  duracaoSegundos: number | null;
}

/**
 * A diferenca entre permanente e temporario decide se vale reenviar. Endereco de
 * webhook que responde 404 nao vai passar a existir na proxima tentativa; 503 vai.
 * Sem essa separacao o despachante fica batendo em porta que nunca abre.
 */
export class FalhaDeEntrega extends Error {
  readonly permanente: boolean;

  constructor(mensagem: string, permanente: boolean) {
    super(mensagem);
    this.name = 'FalhaDeEntrega';
    this.permanente = permanente;
  }
}

export interface Canal {
  readonly tipo: 'email' | 'webhook';
  enviar: (alerta: Alerta, destino: string, segredo: string | null) => Promise<void>;
}

export function resumirAlerta(alerta: Alerta): string {
  if (alerta.evento === 'abriu') {
    return `${alerta.monitorNome} caiu: ${alerta.motivo}`;
  }

  const duracao =
    alerta.duracaoSegundos === null ? '' : ` depois de ${formatarDuracao(alerta.duracaoSegundos)}`;
  return `${alerta.monitorNome} voltou${duracao}`;
}

export function formatarDuracao(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  if (segundos < 3600) return `${Math.floor(segundos / 60)}min`;

  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  return minutos === 0 ? `${horas}h` : `${horas}h${minutos}min`;
}
