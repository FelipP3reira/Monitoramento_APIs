const CHAVE_DO_TOKEN = 'monitoramento:token';

export class NaoAutorizado extends Error {
  constructor() {
    super('O token foi recusado.');
    this.name = 'NaoAutorizado';
  }
}

export function lerToken(): string | null {
  return sessionStorage.getItem(CHAVE_DO_TOKEN);
}

export function guardarToken(token: string): void {
  sessionStorage.setItem(CHAVE_DO_TOKEN, token);
}

export function esquecerToken(): void {
  sessionStorage.removeItem(CHAVE_DO_TOKEN);
}

interface Opcoes {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  corpo?: unknown;
}

export async function chamar<T>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const token = lerToken();

  const resposta = await fetch(`/api${caminho}`, {
    method: opcoes.metodo ?? 'GET',
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(opcoes.corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
  });

  if (resposta.status === 401) {
    esquecerToken();
    throw new NaoAutorizado();
  }

  if (!resposta.ok) {
    const erro = (await resposta.json().catch(() => ({}))) as {
      erro?: string;
      problemas?: { campo: string; mensagem: string }[];
    };
    const detalhe = erro.problemas?.map((problema) => problema.mensagem).join('; ');
    throw new Error(detalhe !== undefined && detalhe !== '' ? detalhe : (erro.erro ?? 'Falhou.'));
  }

  if (resposta.status === 204) return undefined as T;
  return (await resposta.json()) as T;
}
