import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './estilos.css';

const clienteDeConsultas = new QueryClient({
  defaultOptions: {
    queries: {
      // Token recusado nao melhora com insistencia: a tela de entrada reaparece.
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

const raiz = document.getElementById('raiz');
if (raiz === null) throw new Error('Nao encontrei o elemento raiz na pagina.');

createRoot(raiz).render(
  <StrictMode>
    <QueryClientProvider client={clienteDeConsultas}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
