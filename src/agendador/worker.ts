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

import { liberarMonitor, reservarMonitores, type MonitorReservado } from './reserva.ts';

export interface OpcoesDoWorker {
  db: BancoDeDados;
  lote?: number;
  leaseSegundos?: number;
  pausaSemTrabalhoMs?: number;
  dependenciasDoCheck?: DependenciasDoExecutor;
  aoFalhar?: (monitorId: string, erro: Error) => void;
}

export interface Worker {
  cicloUnico: () => Promise<number>;
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
  dependenciasDoCheck = {},
  aoFalhar,
}: OpcoesDoWorker): Worker {
  let rodando = false;

  async function processar(monitor: MonitorReservado): Promise<void> {
    try {
      const resultado = await executarCheck(paraCheck(monitor), dependenciasDoCheck);
      await gravarResultado(db, monitor.id, resultado);
      await atualizarIncidente(
        db,
        monitor.id,
        {
          falhasParaAbrir: monitor.falhas_para_abrir,
          sucessosParaFechar: monitor.sucessos_para_fechar,
        },
        resultado,
      );
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

  async function rodar(): Promise<void> {
    rodando = true;

    while (rodando) {
      const processados = await cicloUnico();
      // Sem trabalho, dorme; com trabalho, emenda o proximo ciclo para nao
      // acumular atraso quando ha mais monitores vencidos do que cabe no lote.
      if (processados === 0) await esperar(pausaSemTrabalhoMs);
    }
  }

  return { cicloUnico, rodar, parar: () => (rodando = false) };
}
