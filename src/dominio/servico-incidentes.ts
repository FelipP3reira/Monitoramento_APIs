import type { ResultadoDoCheck } from '../checagem/executor.ts';
import type { BancoDeDados } from '../db/conexao.ts';

import {
  contarSequencias,
  decidirTransicao,
  historicoNecessario,
  type AcaoDeIncidente,
  type PoliticaDeIncidente,
} from './incidentes.ts';
import {
  abrirIncidente,
  buscarIncidenteAberto,
  contarMaisUmaFalha,
  fecharIncidente,
} from './repositorio-incidentes.ts';
import { ultimosResultados } from './repositorio-resultados.ts';

export interface DecisaoDeIncidente {
  acao: AcaoDeIncidente;
  incidenteId: string | undefined;
}

/**
 * Roda depois do resultado ja estar gravado: o historico lido aqui inclui o check
 * que acabou de acontecer, e e dele que a sequencia atual e derivada.
 */
export async function atualizarIncidente(
  db: BancoDeDados,
  monitorId: string,
  politica: PoliticaDeIncidente,
  resultado: ResultadoDoCheck,
): Promise<DecisaoDeIncidente> {
  const [recentes, incidenteAberto] = await Promise.all([
    ultimosResultados(db, monitorId, historicoNecessario(politica)),
    buscarIncidenteAberto(db, monitorId),
  ]);

  const acao = decidirTransicao(
    incidenteAberto !== undefined,
    contarSequencias(recentes),
    politica,
  );

  if (acao === 'abrir') {
    const incidenteId = await abrirIncidente(db, monitorId, resultado, politica.falhasParaAbrir);
    return { acao: incidenteId === undefined ? 'nada' : 'abrir', incidenteId };
  }

  if (acao === 'fechar') {
    const incidenteId = await fecharIncidente(db, monitorId);
    return { acao: incidenteId === undefined ? 'nada' : 'fechar', incidenteId };
  }

  // Falha durante incidente aberto nao gera aviso novo, mas conta para o placar.
  if (!resultado.sucesso && incidenteAberto !== undefined) {
    await contarMaisUmaFalha(db, monitorId);
  }

  return { acao: 'nada', incidenteId: incidenteAberto?.id };
}
