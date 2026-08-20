import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';

import { chamar } from '../api.ts';
import type { Incidente, PontoDaSerie, ResumoDeUptime } from '../tipos.ts';

import { LinhaDoTempo } from './LinhaDoTempo.tsx';

// A biblioteca de grafico responde por quase todo o peso do pacote. Carregar so
// quando alguem abre um monitor deixa a lista aparecer sem esperar por ela.
const GraficoDeLatencia = lazy(async () => ({
  default: (await import('./GraficoDeLatencia.tsx')).GraficoDeLatencia,
}));

const JANELAS: { rotulo: string; horas: number }[] = [
  { rotulo: '24 horas', horas: 24 },
  { rotulo: '7 dias', horas: 24 * 7 },
  { rotulo: '30 dias', horas: 24 * 30 },
];

function CartaoDeUptime({
  rotulo,
  horas,
  monitorId,
}: {
  rotulo: string;
  horas: number;
  monitorId: string;
}) {
  const { data } = useQuery({
    queryKey: ['uptime', monitorId, horas],
    queryFn: () => chamar<ResumoDeUptime>(`/monitores/${monitorId}/uptime?horas=${horas}`),
    refetchInterval: 30_000,
  });

  return (
    <div className="cartao">
      <span className="titulo-secao" style={{ marginBottom: 4 }}>
        {rotulo}
      </span>
      <div className="grande">
        {data === undefined ? (
          '—'
        ) : data.uptime === null ? (
          <span className="sem-dado">sem dado</span>
        ) : (
          `${data.uptime}%`
        )}
      </div>
      <div className="incidente-detalhe">
        {data === undefined ? '' : `${data.total_de_checks} checks`}
      </div>
    </div>
  );
}

export function DetalheDoMonitor({
  monitorId,
  nome,
}: {
  monitorId: string;
  nome: string;
}): React.JSX.Element {
  const serie = useQuery({
    queryKey: ['serie', monitorId],
    queryFn: () => chamar<PontoDaSerie[]>(`/monitores/${monitorId}/serie?horas=24`),
    refetchInterval: 30_000,
  });

  const incidentes = useQuery({
    queryKey: ['incidentes', monitorId],
    queryFn: () => chamar<Incidente[]>(`/monitores/${monitorId}/incidentes?limite=20`),
    refetchInterval: 30_000,
  });

  return (
    <section className="detalhe">
      <h2 style={{ margin: 0, fontSize: 16 }}>{nome}</h2>

      <div className="faixa-de-cartoes">
        {JANELAS.map((janela) => (
          <CartaoDeUptime
            key={janela.horas}
            rotulo={janela.rotulo}
            horas={janela.horas}
            monitorId={monitorId}
          />
        ))}
      </div>

      <div className="cartao">
        <h3 className="titulo-secao">Latencia nas ultimas 24 horas</h3>
        {serie.isPending ? (
          <p className="vazio">Carregando...</p>
        ) : (
          <Suspense fallback={<p className="vazio">Carregando grafico...</p>}>
            <GraficoDeLatencia serie={serie.data ?? []} />
          </Suspense>
        )}
      </div>

      <div className="cartao">
        <h3 className="titulo-secao">Incidentes</h3>
        {incidentes.isPending ? (
          <p className="vazio">Carregando...</p>
        ) : (
          <LinhaDoTempo incidentes={incidentes.data ?? []} />
        )}
      </div>
    </section>
  );
}
