/**
 * Devolve `null` quando nao houve nenhum check no periodo. Isso e de proposito:
 * um monitor recem-criado, ou um periodo em que o worker esteve parado, nao
 * esteve 100% no ar — nao se sabe. Arredondar isso para 100 seria a mentira mais
 * confortavel e mais cara deste sistema.
 *
 * Pelo mesmo motivo a conta trunca em vez de arredondar: 99,996% arredondado vira
 * 100% e some com quatro falhas reais. So devolve 100 quem nao falhou nenhuma vez.
 */
export function porcentagemDeUptime(total: number, sucessos: number): number | null {
  if (total === 0) return null;
  if (sucessos === total) return 100;

  return Math.floor((sucessos / total) * 10_000) / 100;
}
