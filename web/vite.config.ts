import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Em desenvolvimento o front roda separado; em producao o proprio Fastify
    // entrega o build, entao o caminho /api vale nos dois casos.
    proxy: {
      '/api': 'http://127.0.0.1:3011',
    },
  },
  build: {
    outDir: 'dist',
  },
});
