import type { Incidente } from '../tipos.ts';

function formatarDuracao(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  if (segundos < 3600) return `${Math.floor(segundos / 60)}min`;

  const horas = Math.floor(segundos / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);
  return minutos === 0 ? `${horas}h` : `${horas}h${minutos}min`;
}

function quandoEQuanto(incidente: Incidente): string {
  const inicio = new Date(incidente.aberto_em);
  const quando = inicio.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  if (incidente.fechado_em === null) return `${quando} · em aberto`;

  const segundos = Math.round((new Date(incidente.fechado_em).getTime() - inicio.getTime()) / 1000);
  return `${quando} · durou ${formatarDuracao(segundos)}`;
}

export function LinhaDoTempo({ incidentes }: { incidentes: Incidente[] }): React.JSX.Element {
  if (incidentes.length === 0) {
    return <p className="vazio">Nenhum incidente registrado.</p>;
  }

  return (
    <ul className="linha-do-tempo">
      {incidentes.map((incidente) => (
        <li
          key={incidente.id}
          className={incidente.fechado_em === null ? 'incidente aberto' : 'incidente'}
        >
          <span className="marca" />
          <div>
            <div>
              <strong>{incidente.motivo}</strong> · {incidente.falhas}{' '}
              {incidente.falhas === 1 ? 'falha' : 'falhas'}
            </div>
            <div className="incidente-detalhe">{quandoEQuanto(incidente)}</div>
            {incidente.detalhe === null ? null : (
              <div className="incidente-detalhe">{incidente.detalhe}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
