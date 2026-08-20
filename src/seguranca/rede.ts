import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Um monitor busca URL que o usuario digitou. Sem essa guarda o servico vira um
 * proxy para a rede interna: basta cadastrar http://169.254.169.254/latest/meta-data/
 * e ler a credencial da instancia pela tela de resultado.
 */
export class DestinoBloqueado extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'DestinoBloqueado';
  }
}

const redesInternas = new BlockList();

// Loopback, privadas, link-local (inclui o endereco de metadados das nuvens),
// CGNAT, documentacao, benchmark, multicast e reservadas.
for (const [rede, prefixo] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  redesInternas.addSubnet(rede, prefixo, 'ipv4');
}

for (const [rede, prefixo] of [
  ['::', 128], // nao especificado
  ['::1', 128], // loopback
  ['100::', 64], // descarte
  ['64:ff9b::', 96], // NAT64: carrega um IPv4 embutido que o BlockList nao inspeciona
  ['2001:db8::', 32], // documentacao
  ['2002::', 16], // 6to4: idem NAT64, pode embutir endereco privado
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  if (prefixo === 128) {
    redesInternas.addAddress(rede, 'ipv6');
  } else {
    redesInternas.addSubnet(rede, prefixo, 'ipv6');
  }
}

export function ehEnderecoInterno(endereco: string): boolean {
  const versao = isIP(endereco);
  if (versao === 0) return false;
  return redesInternas.check(endereco, versao === 4 ? 'ipv4' : 'ipv6');
}

const PROTOCOLOS_PERMITIDOS = new Set(['http:', 'https:']);

export function validarUrlDeMonitor(bruta: string): URL {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new DestinoBloqueado('A URL nao e valida.');
  }

  if (!PROTOCOLOS_PERMITIDOS.has(url.protocol)) {
    throw new DestinoBloqueado(`Protocolo ${url.protocol} nao e permitido; use http ou https.`);
  }

  // Usuario e senha embutidos na URL vazam em log e ainda servem para confundir
  // parsers com coisas como https://alvo.com@169.254.169.254/.
  if (url.username !== '' || url.password !== '') {
    throw new DestinoBloqueado('Nao coloque usuario e senha na URL; use um cabecalho.');
  }

  const anfitriao = url.hostname.replace(/^\[|\]$/g, '');
  if (anfitriao === '') {
    throw new DestinoBloqueado('A URL precisa de um host.');
  }

  if (ehEnderecoInterno(anfitriao)) {
    throw new DestinoBloqueado(`${anfitriao} e um endereco de rede interna.`);
  }

  return url;
}

/**
 * Separada de DestinoBloqueado de proposito: "o nome nao existe" e um problema do
 * alvo, e chamar isso de bloqueio faria o operador procurar erro na guarda de
 * rede quando o que tem e um host errado no cadastro.
 */
export class NomeNaoResolvido extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'NomeNaoResolvido';
  }
}

export interface EnderecoResolvido {
  endereco: string;
  familia: 4 | 6;
}

/**
 * Resolve o nome e confere cada endereco devolvido. O check no cadastro nao basta:
 * o DNS pode responder publico agora e privado no proximo check (rebinding), entao
 * isso roda tambem na hora de conectar, a cada salto de redirecionamento.
 */
export async function resolverEnderecoSeguro(anfitriao: string): Promise<EnderecoResolvido> {
  const semColchetes = anfitriao.replace(/^\[|\]$/g, '');

  if (isIP(semColchetes) !== 0) {
    if (ehEnderecoInterno(semColchetes)) {
      throw new DestinoBloqueado(`${semColchetes} e um endereco de rede interna.`);
    }
    return { endereco: semColchetes, familia: isIP(semColchetes) === 4 ? 4 : 6 };
  }

  let encontrados;
  try {
    encontrados = await lookup(semColchetes, { all: true });
  } catch {
    throw new NomeNaoResolvido(`nao consegui resolver o nome ${semColchetes}`);
  }

  // Basta um endereco interno na resposta para recusar: aceitar o primeiro publico
  // deixaria o alvo escolher para onde a conexao vai de fato.
  const interno = encontrados.find((achado) => ehEnderecoInterno(achado.address));
  if (interno !== undefined) {
    throw new DestinoBloqueado(`${semColchetes} aponta para a rede interna (${interno.address}).`);
  }

  const primeiro = encontrados[0];
  if (primeiro === undefined) {
    throw new NomeNaoResolvido(`o nome ${semColchetes} nao resolveu para nenhum endereco`);
  }

  return { endereco: primeiro.address, familia: primeiro.family === 4 ? 4 : 6 };
}
