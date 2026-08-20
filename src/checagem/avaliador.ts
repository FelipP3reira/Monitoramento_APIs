import type { Assertiva } from '../dominio/assertivas.ts';

export interface RespostaChecada {
  corpo: string;
  corpoTruncado: boolean;
  cabecalhos: Record<string, string>;
}

export type ResultadoDaAvaliacao = { ok: true } | { ok: false; detalhe: string };

/**
 * Padrao vem do operador autenticado, mas ainda assim roda contra corpo de
 * terceiro: um padrao com quantificador aninhado somado a uma resposta grande
 * trava o worker. Limitar a entrada nao elimina o risco, so o deixa pequeno o
 * bastante para nao derrubar o processo — a solucao completa seria RE2 ou um
 * worker descartavel, e nenhum dos dois vale o custo neste servico.
 */
const LIMITE_PARA_REGEX = 64 * 1024;

function navegarNoJson(dados: unknown, caminho: string): { achou: boolean; valor: unknown } {
  let atual = dados;

  for (const parte of caminho.split('.')) {
    if (parte === '') continue;
    if (atual === null || typeof atual !== 'object') return { achou: false, valor: undefined };

    const indice = Number(parte);
    if (Array.isArray(atual)) {
      if (!Number.isInteger(indice) || indice < 0 || indice >= atual.length) {
        return { achou: false, valor: undefined };
      }
      atual = atual[indice];
      continue;
    }

    const objeto = atual as Record<string, unknown>;
    if (!(parte in objeto)) return { achou: false, valor: undefined };
    atual = objeto[parte];
  }

  return { achou: true, valor: atual };
}

function avaliarUma(
  assertiva: Assertiva,
  resposta: RespostaChecada,
  lerJson: () => unknown,
): ResultadoDaAvaliacao {
  switch (assertiva.tipo) {
    case 'corpo_contem':
      return resposta.corpo.includes(assertiva.valor)
        ? { ok: true }
        : { ok: false, detalhe: `o corpo nao contem "${assertiva.valor}"` };

    case 'corpo_nao_contem':
      return resposta.corpo.includes(assertiva.valor)
        ? { ok: false, detalhe: `o corpo contem "${assertiva.valor}"` }
        : { ok: true };

    case 'corpo_regex': {
      let padrao: RegExp;
      try {
        padrao = new RegExp(assertiva.valor);
      } catch {
        return { ok: false, detalhe: `o padrao "${assertiva.valor}" nao e uma regex valida` };
      }
      return padrao.test(resposta.corpo.slice(0, LIMITE_PARA_REGEX))
        ? { ok: true }
        : { ok: false, detalhe: `o corpo nao casa com /${assertiva.valor}/` };
    }

    case 'json_existe': {
      const achado = navegarNoJson(lerJson(), assertiva.caminho);
      return achado.achou
        ? { ok: true }
        : { ok: false, detalhe: `o caminho ${assertiva.caminho} nao existe na resposta` };
    }

    case 'json_igual': {
      const achado = navegarNoJson(lerJson(), assertiva.caminho);
      if (!achado.achou) {
        return { ok: false, detalhe: `o caminho ${assertiva.caminho} nao existe na resposta` };
      }
      return achado.valor === assertiva.valor
        ? { ok: true }
        : {
            ok: false,
            detalhe: `${assertiva.caminho} veio ${JSON.stringify(achado.valor)}, esperava ${JSON.stringify(assertiva.valor)}`,
          };
    }

    case 'cabecalho_igual': {
      const recebido = resposta.cabecalhos[assertiva.nome.toLowerCase()];
      return recebido === assertiva.valor
        ? { ok: true }
        : {
            ok: false,
            detalhe: `o cabecalho ${assertiva.nome} veio "${recebido ?? '(ausente)'}", esperava "${assertiva.valor}"`,
          };
    }
  }
}

export function avaliarAssertivas(
  assertivas: Assertiva[],
  resposta: RespostaChecada,
): ResultadoDaAvaliacao {
  // O JSON so e analisado se alguma assertiva pedir, e uma vez so para todas.
  let jsonAnalisado: { valor: unknown } | undefined;
  const lerJson = (): unknown => {
    if (jsonAnalisado === undefined) {
      try {
        jsonAnalisado = { valor: JSON.parse(resposta.corpo) };
      } catch {
        jsonAnalisado = { valor: undefined };
      }
    }
    return jsonAnalisado.valor;
  };

  for (const assertiva of assertivas) {
    const veredito = avaliarUma(assertiva, resposta, lerJson);
    if (!veredito.ok) {
      // Sem esse aviso, uma resposta cortada no limite viraria "conteudo errado"
      // e mandaria o plantao procurar bug onde nao tem.
      const aviso = resposta.corpoTruncado ? ' (o corpo foi cortado no limite de leitura)' : '';
      return { ok: false, detalhe: veredito.detalhe + aviso };
    }
  }

  return { ok: true };
}
