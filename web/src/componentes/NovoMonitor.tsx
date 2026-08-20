import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { chamar } from '../api.ts';
import type { Monitor } from '../tipos.ts';

export function NovoMonitor(): React.JSX.Element {
  const [nome, setNome] = useState('');
  const [url, setUrl] = useState('');
  const [intervalo, setIntervalo] = useState('60');
  const clienteDeConsultas = useQueryClient();

  const criacao = useMutation({
    mutationFn: () =>
      chamar<Monitor>('/monitores', {
        metodo: 'POST',
        corpo: { nome, url, intervalo_segundos: Number(intervalo) },
      }),
    onSuccess: async () => {
      setNome('');
      setUrl('');
      await clienteDeConsultas.invalidateQueries({ queryKey: ['painel'] });
    },
  });

  function enviar(evento: FormEvent): void {
    evento.preventDefault();
    criacao.mutate();
  }

  return (
    <form className="cartao" onSubmit={enviar} style={{ marginBottom: 20 }}>
      <div className="formulario">
        <div className="campo">
          <label htmlFor="nome">Nome</label>
          <input
            id="nome"
            type="text"
            value={nome}
            onChange={(evento) => setNome(evento.target.value)}
            placeholder="API de pagamentos"
            required
          />
        </div>
        <div className="campo">
          <label htmlFor="url">Endereco</label>
          <input
            id="url"
            type="url"
            value={url}
            onChange={(evento) => setUrl(evento.target.value)}
            placeholder="https://exemplo.com/saude"
            required
          />
        </div>
        <div className="campo">
          <label htmlFor="intervalo">Intervalo (s)</label>
          <input
            id="intervalo"
            type="number"
            min={10}
            max={86400}
            value={intervalo}
            onChange={(evento) => setIntervalo(evento.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={criacao.isPending}>
          {criacao.isPending ? 'Salvando...' : 'Monitorar'}
        </button>
      </div>
      {criacao.error === null ? null : (
        <p className="aviso-de-erro" style={{ marginBottom: 0 }}>
          {criacao.error.message}
        </p>
      )}
    </form>
  );
}
