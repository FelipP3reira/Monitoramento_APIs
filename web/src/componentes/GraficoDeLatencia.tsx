import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { PontoDaSerie } from '../tipos.ts';

const horaCurta = (iso: string): string =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function GraficoDeLatencia({ serie }: { serie: PontoDaSerie[] }): React.JSX.Element {
  if (serie.length === 0) {
    return <p className="vazio">Ainda nao ha medicao suficiente para desenhar o grafico.</p>;
  }

  const pontos = serie.map((ponto) => ({
    hora: horaCurta(ponto.hora),
    p50: ponto.latencia_p50,
    p95: ponto.latencia_p95,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={pontos} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke="#232b35" vertical={false} />
        <XAxis dataKey="hora" stroke="#8b98a5" tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis
          stroke="#8b98a5"
          tickLine={false}
          axisLine={false}
          width={52}
          unit="ms"
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: '#171d24',
            border: '1px solid #232b35',
            borderRadius: 8,
            color: '#e6edf3',
          }}
          formatter={(valor: unknown) => (typeof valor === 'number' ? `${valor} ms` : 'sem dado')}
        />
        <Line
          type="monotone"
          dataKey="p50"
          name="mediana"
          stroke="#58a6ff"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="p95"
          name="p95"
          stroke="#d29922"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
