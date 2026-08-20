export type SituacaoDoMonitor = 'no_ar' | 'instavel' | 'fora_do_ar' | 'sem_dados' | 'desligado';

export interface LinhaDoPainel {
  id: string;
  nome: string;
  url: string;
  ativo: boolean;
  situacao: SituacaoDoMonitor;
  ultimo_check: string | null;
  ultima_latencia_ms: number | null;
  ultimo_motivo: string | null;
  incidente_desde: string | null;
  uptime_24h: number | null;
}

export interface ResumoDeUptime {
  desde: string;
  ate: string;
  total_de_checks: number;
  sucessos: number;
  uptime: number | null;
}

export interface PontoDaSerie {
  hora: string;
  total: number;
  sucessos: number;
  uptime: number | null;
  latencia_p50: number | null;
  latencia_p95: number | null;
  latencia_maxima: number | null;
}

export interface Incidente {
  id: string;
  aberto_em: string;
  fechado_em: string | null;
  motivo: string;
  detalhe: string | null;
  falhas: number;
}

export interface Monitor {
  id: string;
  nome: string;
  url: string;
  metodo: string;
  intervalo_segundos: number;
  ativo: boolean;
}
