import {
  entregarPendentes,
  enfileirarAlertas,
  type SaldoDaEntrega,
} from '../alertas/despachante.ts';
import { registroPadrao, type RegistroDeCanais } from '../alertas/registro.ts';
import {
  executarCheck,
  type DependenciasDoExecutor,
  type MonitorParaCheck,
} from '../checagem/executor.ts';
import { config } from '../config.ts';
import type { BancoDeDados } from '../db/conexao.ts';
import { lerCabecalhos } from '../dominio/repositorio-monitores.ts';
import { gravarResultado } from '../dominio/repositorio-resultados.ts';
import { atualizarIncidente } from '../dominio/servico-incidentes.ts';

import { agregarHorasFechadas, aplicarRetencao } from './manutencao.ts';
import { liberarMonitor, reservarMonitores, type MonitorReservado } from './reserva.ts';

export interface OpcoesDoWorker {
  db: BancoDeDados;
  lote?: number;
  leaseSegundos?: number;
  pausaSemTrabalhoMs?: number;
  intervaloDeManutencaoMs?: number;
  retencaoDias?: number;
  loteDeAlertas?: number;
  registroDeCanais?: RegistroDeCanais;
  dependenciasDoCheck?: DependenciasDoExecutor;
  aoFalhar?: (monitorId: string, erro: Error) => void;
}

export interface SaldoDaManutencao {
  horasAgregadas: number;
  resultadosApagados: number;
}

export interface Worker {
  cicloUnico: () => Promise<number>;
  entregarAlertas: () => Promise<SaldoDaEntrega>;
  manutencao: () => Promise<SaldoDaManutencao>;
  rodar: () => Promise<void>;
  parar: () => void;
}

function paraCheck(monitor: MonitorReservado): MonitorParaCheck {
  return {
    url: monitor.url,
    metodo: monitor.metodo,
    cabecalhos: lerCabecalhos(monitor.cabecalhos_cifrados),
    corpo: monitor.corpo,
    timeout_ms: monitor.timeout_ms,
    status_esperado: monitor.status_esperado,
    latencia_maxima_ms: monitor.latencia_maxima_ms,
    assertivas: monitor.assertivas,
  };
}

function esperar(milissegundos: number): Promise<void> {
  return new Promise((pronto) => setTimeout(pronto, milissegundos));
}

export function criarWorker({
  db,
  lote = config.LOTE_DO_WORKER,
  leaseSegundos = config.LEASE_SEGUNDOS,
  pausaSemTrabalhoMs = 1000,
  intervaloDeManutencaoMs = 60_000,
  retencaoDias = config.RETENCAO_DIAS,
  loteDeAlertas = 20,
  registroDeCanais,
  dependenciasDoCheck = {},
  aoFalhar,
}: OpcoesDoWorker): Worker {
  const canais = registroDeCanais ?? registroPadrao();
  let rodando = false;
  let ultimaManutencao = 0;

  async function processar(monitor: MonitorReservado): Promise<void> {
    try {
      const resultado = await executarCheck(paraCheck(monitor), dependenciasDoCheck);
      await gravarResultado(db, monitor.id, resultado);
      const decisao = await atualizarIncidente(
        db,
        monitor.id,
        {
          falhasParaAbrir: monitor.falhas_para_abrir,
          sucessosParaFechar: monitor.sucessos_para_fechar,
        },
        resultado,
      );

      // So a borda do incidente enfileira aviso; falha repetida enquanto o alvo
      // esta fora nao gera nada novo.
      if (decisao.acao !== 'nada' && decisao.incidenteId !== undefined) {
        await enfileirarAlertas(
          db,
          monitor.id,
          decisao.incidenteId,
          decisao.acao === 'abrir' ? 'abriu' : 'fechou',
        );
      }
    } catch (erro) {
      // Um monitor problematico nao pode derrubar o ciclo dos outros.
      aoFalhar?.(monitor.id, erro instanceof Error ? erro : new Error(String(erro)));
    } finally {
      await liberarMonitor(db, monitor.id, monitor.intervalo_segundos);
    }
  }

  async function cicloUnico(): Promise<number> {
    const reservados = await reservarMonitores(db, lote, leaseSegundos);
    if (reservados.length === 0) return 0;

    // O tamanho do lote ja e o limite de concorrencia: nao adianta abrir mais
    // conexoes simultaneas do que o pool do banco aguenta devolver.
    await Promise.all(reservados.map(processar));
    return reservados.length;
  }

  function entregarAlertas(): Promise<SaldoDaEntrega> {
    return entregarPendentes(db, canais, loteDeAlertas);
  }

  // A agregacao precisa vir antes da retencao: apagar o cru de uma hora que ainda
  // nao virou agregado perderia o dado para sempre.
  async function manutencao(): Promise<SaldoDaManutencao> {
    const horasAgregadas = await agregarHorasFechadas(db);
    const resultadosApagados = await aplicarRetencao(db, retencaoDias);

    return { horasAgregadas, resultadosApagados };
  }

  async function rodar(): Promise<void> {
    rodando = true;

    while (rodando) {
      if (Date.now() - ultimaManutencao >= intervaloDeManutencaoMs) {
        await manutencao();
        ultimaManutencao = Date.now();
      }

      const processados = await cicloUnico();
      await entregarAlertas();
      // Sem trabalho, dorme; com trabalho, emenda o proximo ciclo para nao
      // acumular atraso quando ha mais monitores vencidos do que cabe no lote.
      if (processados === 0) await esperar(pausaSemTrabalhoMs);
    }
  }

  return { cicloUnico, entregarAlertas, manutencao, rodar, parar: () => (rodando = false) };
}
