import { criarBanco } from '../db/conexao.ts';

import { criarWorker } from './worker.ts';

const db = criarBanco();
const worker = criarWorker({
  db,
  aoFalhar: (monitorId, erro) => {
    console.error(`Falha inesperada no monitor ${monitorId}: ${erro.message}`);
  },
});

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, () => {
    console.log('Encerrando o worker depois do ciclo atual.');
    worker.parar();
  });
}

console.log('Worker de checagem no ar.');
await worker.rodar();
await db.destroy();
