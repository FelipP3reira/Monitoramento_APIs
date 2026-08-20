import { montarApp } from './app.ts';
import { config } from './config.ts';
import { criarBanco } from './db/conexao.ts';

const db = criarBanco();
const app = await montarApp({ db });

const encerrar = async (): Promise<void> => {
  await app.close();
  await db.destroy();
};

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, () => {
    void encerrar().then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORTA, host: '0.0.0.0' });
