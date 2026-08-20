export interface PoliticaDeIncidente {
  falhasParaAbrir: number;
  sucessosParaFechar: number;
}

export interface SequenciasRecentes {
  falhasSeguidas: number;
  sucessosSeguidos: number;
}

export type AcaoDeIncidente = 'abrir' | 'fechar' | 'nada';

/**
 * Conta a sequencia atual a partir do historico em ordem do mais novo para o mais
 * antigo. So uma das duas contagens e diferente de zero: o ultimo resultado define
 * qual sequencia esta correndo, e o primeiro resultado diferente encerra a conta.
 *
 * Derivar do historico em vez de guardar contador no monitor evita o pior tipo de
 * bug aqui: contador e historico discordarem depois de um worker morrer no meio.
 */
export function contarSequencias(recentes: readonly { sucesso: boolean }[]): SequenciasRecentes {
  const maisRecente = recentes[0];
  if (maisRecente === undefined) return { falhasSeguidas: 0, sucessosSeguidos: 0 };

  let tamanho = 0;
  for (const resultado of recentes) {
    if (resultado.sucesso !== maisRecente.sucesso) break;
    tamanho += 1;
  }

  return maisRecente.sucesso
    ? { falhasSeguidas: 0, sucessosSeguidos: tamanho }
    : { falhasSeguidas: tamanho, sucessosSeguidos: 0 };
}

/**
 * O incidente so muda de estado na borda: com incidente aberto, falha nova nao
 * abre outro, e sem incidente aberto, sucesso nao fecha nada. E por isso que uma
 * queda de meia hora rende dois avisos, e nao um a cada trinta segundos.
 */
export function decidirTransicao(
  incidenteAberto: boolean,
  sequencias: SequenciasRecentes,
  politica: PoliticaDeIncidente,
): AcaoDeIncidente {
  if (!incidenteAberto && sequencias.falhasSeguidas >= politica.falhasParaAbrir) {
    return 'abrir';
  }

  if (incidenteAberto && sequencias.sucessosSeguidos >= politica.sucessosParaFechar) {
    return 'fechar';
  }

  return 'nada';
}

/**
 * Quantos resultados precisam ser lidos para decidir. Ler mais que isso nao muda
 * nenhuma decisao, porque as duas comparacoes sao contra esses limiares.
 */
export function historicoNecessario(politica: PoliticaDeIncidente): number {
  return Math.max(politica.falhasParaAbrir, politica.sucessosParaFechar);
}
