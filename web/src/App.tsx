import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { chamar, esquecerToken, lerToken } from './api.ts';
import { DetalheDoMonitor } from './componentes/DetalheDoMonitor.tsx';
import { EntradaDeToken } from './componentes/EntradaDeToken.tsx';
import { NovoMonitor } from './componentes/NovoMonitor.tsx';
import type { LinhaDoPainel } from './tipos.ts';

const ROTULO_DA_SITUACAO: Record<LinhaDoPainel['situacao'], string> = {
  no_ar: 'no ar',
  instavel: 'instavel',
  fora_do_ar: 'fora do ar',
  sem_dados: 'sem dados',
  desligado: 'desligado',
};

function quandoFoi(iso: string | null): string {
  if (iso === null) return 'nunca checado';

  const segundos = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (segundos < 60) return `ha ${segundos}s`;
  if (segundos < 3600) return `ha ${Math.floor(segundos / 60)}min`;
  return `ha ${Math.floor(segundos / 3600)}h`;
}

function Painel({ aoSair }: { aoSair: () => void }): React.JSX.Element {
  const [selecionado, setSelecionado] = useState<LinhaDoPainel | null>(null);

  const painel = useQuery({
    queryKey: ['painel'],
    queryFn: () => chamar<LinhaDoPainel[]>('/painel'),
    refetchInterval: 15_000,
  });

  const linhas = painel.data ?? [];
  const foraDoAr = linhas.filter((linha) => linha.situacao === 'fora_do_ar').length;

  return (
    <div className="pagina">
      <header className="cabecalho">
        <div>
          <h1>Monitoramento de APIs</h1>
          <p>
            {linhas.length} {linhas.length === 1 ? 'monitor' : 'monitores'}
            {foraDoAr > 0 ? ` · ${foraDoAr} fora do ar` : ' · tudo no ar'}
          </p>
        </div>
        <button className="discreto" onClick={aoSair}>
          Sair
        </button>
      </header>

      <NovoMonitor />

      {painel.isPending ? <p className="vazio">Carregando...</p> : null}

      {painel.error !== null ? <p className="aviso-de-erro">{painel.error.message}</p> : null}

      {!painel.isPending && linhas.length === 0 ? (
        <p className="vazio">Nenhum monitor cadastrado ainda.</p>
      ) : null}

      <div className="lista">
        {linhas.map((linha) => (
          <button
            key={linha.id}
            className="monitor"
            aria-current={selecionado?.id === linha.id}
            onClick={() => setSelecionado(selecionado?.id === linha.id ? null : linha)}
          >
            <span
              className={`farol ${linha.situacao}`}
              title={ROTULO_DA_SITUACAO[linha.situacao]}
            />
            <span>
              <span className="monitor-nome">{linha.nome}</span>
              <span className="monitor-url" style={{ display: 'block' }}>
                {linha.url}
              </span>
            </span>
            <span className="monitor-numeros">
              <span className="numero">
                <strong>
                  {linha.uptime_24h === null ? (
                    <span className="sem-dado">—</span>
                  ) : (
                    `${linha.uptime_24h}%`
                  )}
                </strong>
                <span>uptime 24h</span>
              </span>
              <span className="numero">
                <strong>
                  {linha.ultima_latencia_ms === null ? '—' : `${linha.ultima_latencia_ms} ms`}
                </strong>
                <span>{quandoFoi(linha.ultimo_check)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {selecionado === null ? null : (
        <DetalheDoMonitor monitorId={selecionado.id} nome={selecionado.nome} />
      )}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [autenticado, setAutenticado] = useState(lerToken() !== null);

  if (!autenticado) {
    return <EntradaDeToken aoEntrar={() => setAutenticado(true)} />;
  }

  return (
    <Painel
      aoSair={() => {
        esquecerToken();
        setAutenticado(false);
      }}
    />
  );
}
