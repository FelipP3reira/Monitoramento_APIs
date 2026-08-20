import { useState, type FormEvent } from 'react';

import { chamar, guardarToken } from '../api.ts';

export function EntradaDeToken({ aoEntrar }: { aoEntrar: () => void }): React.JSX.Element {
  const [token, setToken] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [conferindo, setConferindo] = useState(false);

  async function enviar(evento: FormEvent): Promise<void> {
    evento.preventDefault();
    setConferindo(true);
    setErro(null);
    guardarToken(token.trim());

    try {
      await chamar('/painel');
      aoEntrar();
    } catch {
      setErro('Esse token nao foi aceito.');
    } finally {
      setConferindo(false);
    }
  }

  return (
    <form className="entrada cartao" onSubmit={(evento) => void enviar(evento)}>
      <h1 style={{ margin: 0, fontSize: 16 }}>Monitoramento de APIs</h1>
      <p style={{ margin: 0, color: 'var(--suave)' }}>
        Informe o token da API para abrir o painel. Ele fica so nesta aba do navegador.
      </p>
      <input
        type="password"
        value={token}
        onChange={(evento) => setToken(evento.target.value)}
        placeholder="Token"
        autoFocus
      />
      {erro === null ? null : <p className="aviso-de-erro">{erro}</p>}
      <button type="submit" disabled={token.trim() === '' || conferindo}>
        {conferindo ? 'Conferindo...' : 'Entrar'}
      </button>
    </form>
  );
}
