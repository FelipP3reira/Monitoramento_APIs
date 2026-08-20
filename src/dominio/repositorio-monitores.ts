import { sql } from 'kysely';

import type { BancoDeDados } from '../db/conexao.ts';
import type { MetodoHttp } from '../db/tipos.ts';
import { cifrar, decifrar } from '../seguranca/cifra.ts';

import type { Assertiva } from './assertivas.ts';
import type { DadosDeAtualizacao, DadosDeCriacao } from './monitor.ts';

export interface MonitorPublico {
  id: string;
  nome: string;
  url: string;
  metodo: MetodoHttp;
  cabecalhos_definidos: string[];
  tem_corpo: boolean;
  intervalo_segundos: number;
  timeout_ms: number;
  status_esperado: number[];
  latencia_maxima_ms: number | null;
  assertivas: Assertiva[];
  falhas_para_abrir: number;
  sucessos_para_fechar: number;
  ativo: boolean;
  proximo_check_em: Date;
  criado_em: Date;
}

interface LinhaDeMonitor {
  id: string;
  nome: string;
  url: string;
  metodo: MetodoHttp;
  cabecalhos_cifrados: string | null;
  corpo: string | null;
  intervalo_segundos: number;
  timeout_ms: number;
  status_esperado: number[];
  latencia_maxima_ms: number | null;
  assertivas: Assertiva[];
  falhas_para_abrir: number;
  sucessos_para_fechar: number;
  ativo: boolean;
  proximo_check_em: Date;
  criado_em: Date;
}

export function lerCabecalhos(cifrados: string | null): Record<string, string> {
  if (cifrados === null) return {};
  return JSON.parse(decifrar(cifrados)) as Record<string, string>;
}

/**
 * O valor do cabecalho nunca sai da API: quem cadastrou ja sabe o token, e quem
 * roubou o token da API nao deveria ganhar de brinde os tokens dos alvos.
 */
function paraPublico(linha: LinhaDeMonitor): MonitorPublico {
  return {
    id: linha.id,
    nome: linha.nome,
    url: linha.url,
    metodo: linha.metodo,
    cabecalhos_definidos: Object.keys(lerCabecalhos(linha.cabecalhos_cifrados)),
    tem_corpo: linha.corpo !== null,
    intervalo_segundos: linha.intervalo_segundos,
    timeout_ms: linha.timeout_ms,
    status_esperado: linha.status_esperado,
    latencia_maxima_ms: linha.latencia_maxima_ms,
    assertivas: linha.assertivas,
    falhas_para_abrir: linha.falhas_para_abrir,
    sucessos_para_fechar: linha.sucessos_para_fechar,
    ativo: linha.ativo,
    proximo_check_em: linha.proximo_check_em,
    criado_em: linha.criado_em,
  };
}

const COLUNAS_PUBLICAS = [
  'id',
  'nome',
  'url',
  'metodo',
  'cabecalhos_cifrados',
  'corpo',
  'intervalo_segundos',
  'timeout_ms',
  'status_esperado',
  'latencia_maxima_ms',
  'assertivas',
  'falhas_para_abrir',
  'sucessos_para_fechar',
  'ativo',
  'proximo_check_em',
  'criado_em',
] as const;

export async function criarMonitor(
  db: BancoDeDados,
  dados: DadosDeCriacao,
): Promise<MonitorPublico> {
  const linha = await db
    .insertInto('monitores')
    .values({
      nome: dados.nome,
      url: dados.url,
      metodo: dados.metodo,
      cabecalhos_cifrados:
        dados.cabecalhos === undefined ? null : cifrar(JSON.stringify(dados.cabecalhos)),
      corpo: dados.corpo ?? null,
      intervalo_segundos: dados.intervalo_segundos,
      timeout_ms: dados.timeout_ms,
      status_esperado: dados.status_esperado,
      latencia_maxima_ms: dados.latencia_maxima_ms,
      assertivas: JSON.stringify(dados.assertivas),
      falhas_para_abrir: dados.falhas_para_abrir,
      sucessos_para_fechar: dados.sucessos_para_fechar,
      ativo: dados.ativo,
    })
    .returning(COLUNAS_PUBLICAS)
    .executeTakeFirstOrThrow();

  return paraPublico(linha);
}

export async function listarMonitores(db: BancoDeDados): Promise<MonitorPublico[]> {
  const linhas = await db
    .selectFrom('monitores')
    .select(COLUNAS_PUBLICAS)
    .orderBy('criado_em', 'desc')
    .execute();

  return linhas.map(paraPublico);
}

export async function buscarMonitor(
  db: BancoDeDados,
  id: string,
): Promise<MonitorPublico | undefined> {
  const linha = await db
    .selectFrom('monitores')
    .select(COLUNAS_PUBLICAS)
    .where('id', '=', id)
    .executeTakeFirst();

  return linha === undefined ? undefined : paraPublico(linha);
}

export async function atualizarMonitor(
  db: BancoDeDados,
  id: string,
  dados: DadosDeAtualizacao,
): Promise<MonitorPublico | undefined> {
  const campos: Record<string, unknown> = { atualizado_em: sql`now()` };

  if (dados.nome !== undefined) campos.nome = dados.nome;
  if (dados.url !== undefined) campos.url = dados.url;
  if (dados.metodo !== undefined) campos.metodo = dados.metodo;
  if (dados.cabecalhos !== undefined)
    campos.cabecalhos_cifrados = cifrar(JSON.stringify(dados.cabecalhos));
  if (dados.corpo !== undefined) campos.corpo = dados.corpo;
  if (dados.intervalo_segundos !== undefined) campos.intervalo_segundos = dados.intervalo_segundos;
  if (dados.timeout_ms !== undefined) campos.timeout_ms = dados.timeout_ms;
  if (dados.status_esperado !== undefined) campos.status_esperado = dados.status_esperado;
  if (dados.latencia_maxima_ms !== undefined) campos.latencia_maxima_ms = dados.latencia_maxima_ms;
  if (dados.assertivas !== undefined) campos.assertivas = JSON.stringify(dados.assertivas);
  if (dados.falhas_para_abrir !== undefined) campos.falhas_para_abrir = dados.falhas_para_abrir;
  if (dados.sucessos_para_fechar !== undefined) {
    campos.sucessos_para_fechar = dados.sucessos_para_fechar;
  }
  if (dados.ativo !== undefined) campos.ativo = dados.ativo;

  const linha = await db
    .updateTable('monitores')
    .set(campos)
    .where('id', '=', id)
    .returning(COLUNAS_PUBLICAS)
    .executeTakeFirst();

  return linha === undefined ? undefined : paraPublico(linha);
}

export async function removerMonitor(db: BancoDeDados, id: string): Promise<boolean> {
  const removido = await db
    .deleteFrom('monitores')
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();

  return removido !== undefined;
}
