import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { EnderecoResolvido } from '../../src/seguranca/rede.ts';

export interface ServidorDeTeste {
  porta: number;
  fechar: () => Promise<void>;
}

export type Manipulador = (requisicao: IncomingMessage, resposta: ServerResponse) => void;

export async function subirServidor(manipulador: Manipulador): Promise<ServidorDeTeste> {
  const servidor = createServer(manipulador);
  await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));

  const endereco = servidor.address();
  const porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;

  return {
    porta,
    fechar: () =>
      new Promise<void>((pronto) => {
        // Sem isso o close fica esperando a conexao do teste de timeout.
        servidor.closeAllConnections();
        servidor.close(() => pronto());
      }),
  };
}

/**
 * A guarda de SSRF recusa loopback de proposito, entao o teste troca so a peca de
 * resolucao. O executor continua rodando todo o resto do caminho de producao.
 */
export function resolverParaLoopback(): Promise<EnderecoResolvido> {
  return Promise.resolve({ endereco: '127.0.0.1', familia: 4 });
}
