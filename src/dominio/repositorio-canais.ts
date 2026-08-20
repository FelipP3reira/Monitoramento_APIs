import type { BancoDeDados } from '../db/conexao.ts';
import { cifrar } from '../seguranca/cifra.ts';

export interface DadosDoCanal {
  monitor_id: string | null;
  tipo: 'email' | 'webhook';
  destino: string;
  segredo?: string;
  ativo: boolean;
}

export interface CanalPublico {
  id: string;
  monitor_id: string | null;
  tipo: 'email' | 'webhook';
  destino: string;
  tem_segredo: boolean;
  ativo: boolean;
  criado_em: Date;
}

export async function criarCanal(db: BancoDeDados, dados: DadosDoCanal): Promise<CanalPublico> {
  const linha = await db
    .insertInto('canais_alerta')
    .values({
      monitor_id: dados.monitor_id,
      tipo: dados.tipo,
      destino: dados.destino,
      segredo_cifrado: dados.segredo === undefined ? null : cifrar(dados.segredo),
      ativo: dados.ativo,
    })
    .returning(['id', 'monitor_id', 'tipo', 'destino', 'segredo_cifrado', 'ativo', 'criado_em'])
    .executeTakeFirstOrThrow();

  return {
    id: linha.id,
    monitor_id: linha.monitor_id,
    tipo: linha.tipo,
    destino: linha.destino,
    tem_segredo: linha.segredo_cifrado !== null,
    ativo: linha.ativo,
    criado_em: linha.criado_em,
  };
}

export async function listarCanais(db: BancoDeDados): Promise<CanalPublico[]> {
  const linhas = await db
    .selectFrom('canais_alerta')
    .select(['id', 'monitor_id', 'tipo', 'destino', 'segredo_cifrado', 'ativo', 'criado_em'])
    .orderBy('criado_em', 'desc')
    .execute();

  return linhas.map((linha) => ({
    id: linha.id,
    monitor_id: linha.monitor_id,
    tipo: linha.tipo,
    destino: linha.destino,
    tem_segredo: linha.segredo_cifrado !== null,
    ativo: linha.ativo,
    criado_em: linha.criado_em,
  }));
}

export async function removerCanal(db: BancoDeDados, id: string): Promise<boolean> {
  const removido = await db
    .deleteFrom('canais_alerta')
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();

  return removido !== undefined;
}
