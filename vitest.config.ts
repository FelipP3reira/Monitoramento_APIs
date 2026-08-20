import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // O config.ts valida o ambiente no import, entao as variaveis precisam existir
    // antes de qualquer modulo ser carregado.
    env: {
      DATABASE_URL: 'postgres://monitoramento:monitoramento@localhost:5441/monitoramento_teste',
      AMBIENTE: 'teste',
      API_TOKEN: 'token-de-teste-com-tamanho-suficiente',
      CHAVE_CIFRA: '0'.repeat(64),
      PORTA: '3011',
    },
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
