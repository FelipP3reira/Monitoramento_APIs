import type { ColumnType, Generated, JSONColumnType } from 'kysely';

import type { Assertiva } from '../dominio/assertivas.ts';

type CriadoPeloBanco = ColumnType<Date, Date | string | undefined, never>;

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type MotivoDeFalha =
  'conexao' | 'timeout' | 'status' | 'latencia' | 'assertiva' | 'bloqueado';

export interface TabelaMonitores {
  id: Generated<string>;
  nome: string;
  url: string;
  metodo: Generated<MetodoHttp>;
  cabecalhos_cifrados: string | null;
  corpo: string | null;
  intervalo_segundos: number;
  timeout_ms: Generated<number>;
  status_esperado: Generated<number[]>;
  latencia_maxima_ms: number | null;
  assertivas: JSONColumnType<Assertiva[], string, string>;
  falhas_para_abrir: Generated<number>;
  sucessos_para_fechar: Generated<number>;
  ativo: Generated<boolean>;
  proximo_check_em: ColumnType<Date, Date | string | undefined, Date | string>;
  reservado_ate: ColumnType<Date | null, Date | string | null, Date | string | null>;
  criado_em: CriadoPeloBanco;
  atualizado_em: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface TabelaResultados {
  id: Generated<number>;
  monitor_id: string;
  verificado_em: ColumnType<Date, Date | string | undefined, never>;
  sucesso: boolean;
  codigo_http: number | null;
  latencia_ms: number | null;
  motivo_falha: MotivoDeFalha | null;
  detalhe: string | null;
}

export interface TabelaAgregadosHora {
  monitor_id: string;
  hora: ColumnType<Date, Date | string, Date | string>;
  total: number;
  sucessos: number;
  latencia_p50: number | null;
  latencia_p95: number | null;
  latencia_maxima: number | null;
}

export interface TabelaIncidentes {
  id: Generated<string>;
  monitor_id: string;
  aberto_em: ColumnType<Date, Date | string | undefined, never>;
  fechado_em: ColumnType<Date | null, Date | string | null, Date | string | null>;
  motivo: string;
  detalhe: string | null;
  falhas: Generated<number>;
}

export interface TabelaCanaisAlerta {
  id: Generated<string>;
  monitor_id: string | null;
  tipo: 'email' | 'webhook';
  destino: string;
  segredo_cifrado: string | null;
  ativo: Generated<boolean>;
  criado_em: CriadoPeloBanco;
}

export interface TabelaAlertasEnviados {
  id: Generated<number>;
  incidente_id: string;
  canal_id: string;
  evento: 'abriu' | 'fechou';
  chave_idempotencia: string;
  situacao: Generated<'pendente' | 'enviado' | 'falhou'>;
  tentativas: Generated<number>;
  ultimo_erro: string | null;
  criado_em: CriadoPeloBanco;
  enviado_em: ColumnType<Date | null, Date | string | null, Date | string | null>;
  proxima_tentativa_em: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface Banco {
  monitores: TabelaMonitores;
  resultados: TabelaResultados;
  agregados_hora: TabelaAgregadosHora;
  incidentes: TabelaIncidentes;
  canais_alerta: TabelaCanaisAlerta;
  alertas_enviados: TabelaAlertasEnviados;
}
