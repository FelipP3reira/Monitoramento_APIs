import { describe, expect, it } from 'vitest';

import {
  DestinoBloqueado,
  ehEnderecoInterno,
  NomeNaoResolvido,
  resolverEnderecoSeguro,
  validarUrlDeMonitor,
} from '../src/seguranca/rede.ts';

describe('classificacao de endereco', () => {
  const internos = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // metadados de EC2, GCP e Azure
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1', // loopback disfarcado de IPv6
    '::ffff:169.254.169.254',
    '2002:0a00:0001::1', // 6to4 carregando 10.0.0.1
    '64:ff9b::a00:1', // NAT64 carregando 10.0.0.1
  ];

  it.each(internos)('recusa %s', (endereco) => {
    expect(ehEnderecoInterno(endereco)).toBe(true);
  });

  const publicos = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // logo depois da faixa privada 172.16/12
    '100.128.0.1', // logo depois do CGNAT
    '169.253.0.1', // logo antes do link-local
    '2606:4700::1111',
  ];

  it.each(publicos)('aceita %s', (endereco) => {
    expect(ehEnderecoInterno(endereco)).toBe(false);
  });

  it('nao trata texto solto como endereco', () => {
    expect(ehEnderecoInterno('exemplo.com')).toBe(false);
  });
});

describe('validacao da URL do monitor', () => {
  it('aceita http e https publicos', () => {
    expect(validarUrlDeMonitor('https://exemplo.com/saude').hostname).toBe('exemplo.com');
    expect(validarUrlDeMonitor('http://exemplo.com:8080/saude').port).toBe('8080');
  });

  it.each([
    ['file:///etc/passwd', 'protocolo'],
    ['ftp://exemplo.com', 'protocolo'],
    ['gopher://exemplo.com', 'protocolo'],
  ])('recusa %s por causa do %s', (url) => {
    expect(() => validarUrlDeMonitor(url)).toThrow(DestinoBloqueado);
  });

  it('recusa credencial embutida na URL', () => {
    expect(() => validarUrlDeMonitor('https://exemplo.com@169.254.169.254/')).toThrow(
      /usuario e senha/i,
    );
  });

  it('recusa IP interno escrito direto', () => {
    expect(() => validarUrlDeMonitor('http://169.254.169.254/latest/meta-data/')).toThrow(
      /rede interna/i,
    );
    expect(() => validarUrlDeMonitor('http://[::1]:3000/')).toThrow(/rede interna/i);
  });

  it('recusa texto que nem e URL', () => {
    expect(() => validarUrlDeMonitor('nao sou uma url')).toThrow(DestinoBloqueado);
  });
});

describe('resolucao do destino', () => {
  it('bloqueia nome que resolve para loopback', async () => {
    await expect(resolverEnderecoSeguro('localhost')).rejects.toThrow(/rede interna/i);
  });

  it('bloqueia IP interno passado direto', async () => {
    await expect(resolverEnderecoSeguro('10.1.2.3')).rejects.toThrow(/rede interna/i);
  });

  it('devolve o endereco de um IP publico sem consultar DNS', async () => {
    await expect(resolverEnderecoSeguro('1.1.1.1')).resolves.toEqual({
      endereco: '1.1.1.1',
      familia: 4,
    });
  });

  it('separa nome inexistente de destino bloqueado', async () => {
    const tentativa = resolverEnderecoSeguro('nome-que-nao-existe-em-lugar-nenhum.invalid');

    await expect(tentativa).rejects.toThrow(NomeNaoResolvido);
    await expect(tentativa).rejects.not.toThrow(DestinoBloqueado);
  });
});
