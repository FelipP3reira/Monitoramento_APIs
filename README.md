# Monitoramento de APIs

Monitor de disponibilidade e latência de endpoints HTTP. Cadastra um endereço,
checa de tempos em tempos, guarda o histórico, agrupa as falhas em incidentes e
avisa por e-mail ou webhook quando algo cai — e quando volta.

É a ideia de um Uptime Kuma, escrita do zero para entender as partes que
costumam ficar escondidas: como distribuir checks entre vários workers sem
duplicar, como guardar série temporal sem a tabela crescer para sempre, e como
avisar de uma queda sem transformar a caixa de entrada em log.

## O que ele faz

- Cadastro de endpoints com método, cabeçalhos, corpo, status esperado, limite de
  latência e intervalo de checagem
- Checagem agendada rodando num worker separado da API
- Assertivas de **conteúdo**, não só código HTTP: texto no corpo, expressão
  regular, caminho no JSON e cabeçalho da resposta
- Histórico de latência e status, com agregação por hora e retenção configurável
- Uptime por período de até 90 dias
- Detecção de incidente por falhas seguidas, com fechamento por sucessos seguidos
- Alerta por e-mail e webhook na abertura e no fechamento do incidente
- Painel web com farol de situação, gráfico de latência e linha do tempo

## Como rodar

Precisa de Node 24 e Docker.

```bash
docker compose up -d          # Postgres na porta 5441
npm install
cp .env.example .env          # gere API_TOKEN e CHAVE_CIFRA (instruções no arquivo)
npm run migrar

npm run dev                   # API em http://localhost:3011
npm run worker                # em outro terminal: executa os checks
```

O painel roda separado em desenvolvimento, com proxy para a API:

```bash
npm run painel                # http://localhost:5173
```

Em produção não são dois servidores: `npm run painel:build` gera o pacote e o
próprio Fastify passa a servi-lo em `/`.

```bash
npm test                      # 160 testes
npm run tipos                 # checagem de tipos da API e do painel
npm run lint
```

Os testes usam o banco `monitoramento_teste`, criado junto com o container.

## Endpoints

Tudo em `/api` exige `Authorization: Bearer <API_TOKEN>`. `/saude` fica aberto.

| Método | Caminho                                 | Para quê                                    |
| ------ | --------------------------------------- | ------------------------------------------- |
| GET    | `/saude`                                | Verificação de vida do processo             |
| GET    | `/api/painel`                           | Situação de todos os monitores numa chamada |
| POST   | `/api/monitores`                        | Cadastra um monitor                         |
| GET    | `/api/monitores`                        | Lista a configuração dos monitores          |
| GET    | `/api/monitores/:id`                    | Um monitor                                  |
| PATCH  | `/api/monitores/:id`                    | Altera campos específicos                   |
| DELETE | `/api/monitores/:id`                    | Remove o monitor e o histórico              |
| GET    | `/api/monitores/:id/uptime?horas=`      | Uptime do período                           |
| GET    | `/api/monitores/:id/serie?horas=`       | Série por hora, com percentis               |
| GET    | `/api/monitores/:id/incidentes?limite=` | Linha do tempo                              |
| POST   | `/api/canais`                           | Cadastra canal de alerta                    |
| GET    | `/api/canais`                           | Lista canais                                |
| DELETE | `/api/canais/:id`                       | Remove canal                                |

Exemplo de cadastro com assertiva de conteúdo:

```json
{
  "nome": "API de pedidos",
  "url": "https://exemplo.com/saude",
  "intervalo_segundos": 60,
  "timeout_ms": 5000,
  "status_esperado": [200],
  "latencia_maxima_ms": 800,
  "falhas_para_abrir": 3,
  "sucessos_para_fechar": 2,
  "assertivas": [
    { "tipo": "json_igual", "caminho": "banco.conectado", "valor": true },
    { "tipo": "corpo_nao_contem", "valor": "manutencao" }
  ]
}
```

## Como está organizado

```
src/
  agendador/   reserva do lote, worker, agregação e retenção
  alertas/     canais, despachante e cliente HTTP dos webhooks
  checagem/    executor do check e avaliador de assertivas
  db/          conexão, tipos das tabelas e migrações
  dominio/     regras e repositórios
  rotas/       API HTTP
  seguranca/   guarda de rede, cifra, HMAC e autenticação
web/           painel em React
```

## Decisões

### Agendamento no Postgres, sem fila

Já tenho uma [fila de jobs sobre Redis](https://github.com/FelipP3reira/Sistema_Filas)
escrita à mão, e o reflexo era reaproveitá-la aqui. Não reaproveitei: check
periódico não é job avulso, é um cursor que se reagenda sozinho. Modelar como
job significaria reenfileirar a cada execução e carregar uma dependência de
infraestrutura inteira para isso.

O que resolve é uma consulta:

```sql
update monitores set reservado_ate = now() + ...
where id in (
  select id from monitores
  where ativo and proximo_check_em <= now()
    and (reservado_ate is null or reservado_ate < now())
  order by proximo_check_em limit $1
  for update skip locked
)
returning ...
```

O `skip locked` deixa vários workers rodarem sem coordenação externa: quem chega
depois pula as linhas travadas em vez de esperar. E o `reservado_ate` cobre a
falha: worker que morre no meio do check tem a reserva vencida, e o monitor volta
para a fila no ciclo seguinte — sem rotina de limpeza, sem heartbeat.

**O custo:** cada ciclo é um `UPDATE` no banco. Com dezenas de milhares de
monitores, uma fila em memória sairia mais barata. Nessa escala, essa decisão
mudaria.

O próximo check parte de `now()`, não do horário que estava agendado. Somar ao
horário antigo mantém a cadência exata, mas depois de uma parada longa faria o
worker disparar de uma vez todos os checks atrasados, justo em cima de um alvo
que talvez esteja voltando.

### Histórico cru mais agregado por hora

`resultados` guarda cada check. `agregados_hora` guarda total, sucessos, p50, p95
e máximo de cada hora fechada. A divisão é fixa: **o agregado responde pelas
horas fechadas, o cru só pela hora corrente**. Como as duas fontes nunca cobrem a
mesma hora, não existe caminho para contar um check duas vezes.

O motivo é tamanho. Noventa dias de um monitor de 30 em 30 segundos são cerca de
260 mil linhas cruas contra 2160 de agregado. A retenção apaga o cru e mantém o
agregado, então o uptime de 90 dias continua respondendo com retenção de 30 dias.

A agregação é um `insert ... on conflict do update` com janela de 48 horas, então
pode rodar quantas vezes precisar e ainda refaz sozinha qualquer hora que ficou
para trás por causa de um worker derrubado.

Índices: `BRIN` em `resultados.verificado_em`, porque a tabela só cresce em ordem
de tempo e o índice de faixa cabe em alguns kilobytes onde o btree custaria
centenas de megabytes; e btree em `(monitor_id, verificado_em desc)` para as
consultas por monitor.

### Uptime que não arredonda para cima

Duas escolhas que parecem detalhe e não são:

**Período sem nenhum check devolve `null`, não 100%.** Monitor recém-criado, ou
período em que o worker esteve parado, não esteve no ar — não se sabe. Retornar
100 seria a mentira mais confortável e mais cara deste sistema.

**A conta trunca em vez de arredondar.** 99,996% arredondado vira 100% e some com
quatro falhas reais. Só devolve 100 quem não falhou nenhuma vez.

Pelo mesmo motivo o resumo **não** devolve percentil do período: percentil de
período não é recuperável a partir de percentis horários, e uma média de p95
daria um número que parece certo e não é. A latência aparece na série por hora,
onde cada ponto tem o percentil daquela hora.

**Limitação conhecida:** o uptime é a razão entre checks bem-sucedidos e checks
totais, não ponderado por tempo. Como os checks são equidistantes, os dois
números coincidem na prática — mas se o intervalo mudar no meio do período, ou se
o worker ficar parado, a razão passa a mentir um pouco. Ponderar por tempo exigiria
reconstruir a linha do tempo a partir dos incidentes, e não valeu a complexidade.

### Incidente decidido por função pura

`decidirTransicao(incidenteAberto, sequencias, politica)` não toca em banco, rede
nem relógio. Recebe se há incidente aberto e as sequências atuais, devolve
`abrir`, `fechar` ou `nada`.

A sequência é **derivada do histórico**, não guardada num contador no monitor.
Contador e histórico discordarem depois de um worker morrer no meio seria o pior
tipo de bug para depurar aqui, e a leitura custa `max(falhas_para_abrir,
sucessos_para_fechar)` linhas de um índice que já existe.

A unicidade não fica na aplicação. O índice único parcial

```sql
create unique index incidentes_um_aberto_por_monitor on incidentes (monitor_id)
  where fechado_em is null;
```

torna dois incidentes abertos no mesmo monitor impossíveis. O `on conflict do
nothing` aponta para ele, então abertura concorrente vira um incidente só.

### Alerta sem virar spam

Três camadas, e a primeira é a que mais importa:

1. **Só a borda do incidente enfileira aviso.** Falha repetida enquanto o alvo
   está fora não gera nada. Uma queda de meia hora rende dois avisos, não um a
   cada trinta segundos.
2. **Chave única `(incidente, evento, canal)`** no banco. Mesmo com dois
   processos despachando, o segundo não cria linha.
3. **Reenvio com espera crescente**, e só para falha temporária.

Sobre o que é temporário: `4xx` é permanente e desiste na hora, exceto `408` e
`429` — os dois códigos da família que literalmente pedem para tentar de novo.
Endereço que responde 404 não vai passar a existir na próxima tentativa.

O webhook vai assinado com HMAC-SHA256 sobre os bytes exatos do corpo, no
cabeçalho `X-Monitoramento-Assinatura`.

### Cliente HTTP escrito na mão

O executor usa `node:http` e `node:https` direto, não `fetch`. O motivo é a
guarda de rede: preciso conectar **no IP que já foi conferido**, e não no que o
DNS resolver de novo na hora de abrir o socket. Com `http.request` dá para passar
o IP como host mantendo `Host` e `servername` do nome original, então o
certificado continua sendo validado contra o nome e não contra o IP.

Redirecionamento também é seguido na mão, para a guarda rodar de novo a cada
salto. Três detalhes que vieram junto:

- Ao trocar de host num redirecionamento, `Authorization` e `Cookie` são
  retirados. Trocar de host é trocar de destinatário.
- O corte de 1 MB no corpo vale **depois** de descomprimir. Contar bytes antes do
  gunzip deixaria uma bomba de compressão passar.
- A ordem de julgamento é status, conteúdo e só então latência. Uma resposta 500
  lenta é reportada como status: o motivo errado manda o plantão para o lado
  errado.

## Segurança

O ponto crítico deste projeto é **SSRF**. Um serviço que busca URL digitada pelo
usuário é, por construção, um proxy para a rede interna: bastaria cadastrar
`http://169.254.169.254/latest/meta-data/` e ler credencial de instância pela
própria tela de resultado.

`src/seguranca/rede.ts` barra as faixas privadas, loopback, link-local (onde mora
o endereço de metadados das nuvens), CGNAT, multicast e reservadas. Além delas:

- `::ffff:127.0.0.1` — loopback disfarçado de IPv6
- `2002::/16` (6to4) e `64:ff9b::/96` (NAT64) — carregam um IPv4 embutido que
  passaria batido numa verificação ingênua

A checagem roda no cadastro, **de novo na hora de conectar** (o DNS pode
responder público agora e privado no próximo check) e **a cada redirecionamento**.
O endereço do webhook de alerta passa pela mesma guarda — sem isso o cadastro de
canal seria a porta dos fundos do que a rota de monitor fecha na frente.

O resto do checklist:

| Item                  | Onde                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Validação de entrada  | Zod em toda rota, inclusive nas assertivas                                                                |
| Segredos do usuário   | Cabeçalhos e segredo de webhook cifrados com AES-256-GCM e nunca devolvidos pela API                      |
| Autenticação          | Token Bearer comparado com `timingSafeEqual`                                                              |
| SQL                   | Kysely; onde há SQL escrito à mão, sempre com parâmetros                                                  |
| Cabeçalhos            | `@fastify/helmet` com CSP                                                                                 |
| Limite de chamadas    | `@fastify/rate-limit`, mais restrito nas rotas de escrita                                                 |
| Teto de corpo         | 1 MB na resposta do alvo, 64 KB no corpo da requisição                                                    |
| Injeção de cabeçalho  | Valor com quebra de linha é recusado; `Content-Length`, `Connection` e `Transfer-Encoding` são reservados |
| Segredos da aplicação | `.env` fora do versionamento, `.env.example` versionado                                                   |

### Limites conhecidos

Coisas que eu preferiria dizer do que esconder:

- **ReDoS na assertiva `corpo_regex`.** O padrão vem de um operador autenticado,
  mas roda contra corpo de terceiro. O que existe hoje é limite de tamanho no
  padrão e no trecho analisado (64 KB), o que reduz o estrago sem eliminá-lo. A
  solução completa seria RE2 ou um worker descartável com timeout, e nenhuma das
  duas me pareceu valer o custo neste serviço.
- **Token no `sessionStorage` do painel.** Some ao fechar a aba e não vai para o
  disco, mas um XSS na página conseguiria lê-lo. Quem segura essa ponta é a CSP.
- **Um token só, sem usuários.** É um serviço de uso interno; não há multiusuário
  nem permissões.
- **TLS fica com o proxy reverso.** A aplicação fala HTTP; HSTS já vai no
  cabeçalho, mas quem termina TLS é a camada da frente.
- **Certificado do alvo é sempre validado.** Não há opção de monitorar endpoint
  com certificado autoassinado.

### Backup

O estado inteiro está no Postgres; a aplicação não guarda nada em disco.

```bash
# cópia
docker exec monitoramento-postgres pg_dump -U monitoramento monitoramento \
  | gzip > backup-$(date +%F).sql.gz
```

A restauração precisa de um **banco vazio**. O dump não traz `DROP`, então jogá-lo
por cima de um banco que já tem as tabelas só produz erro de objeto duplicado —
testei, são 31 erros e nenhum dado restaurado:

```bash
docker exec monitoramento-postgres psql -U monitoramento -c 'create database restauracao;'
gunzip -c backup-2026-08-20.sql.gz \
  | docker exec -i monitoramento-postgres psql -U monitoramento -d restauracao
```

Depois é só apontar a `DATABASE_URL` para o banco restaurado, ou renomear os dois.

Duas observações. A `CHAVE_CIFRA` **não** está no banco: sem ela, os cabeçalhos e
segredos restaurados são bytes inúteis — guarde as duas coisas juntas. E o dump
inclui `resultados`, que é a maior tabela; para backup diário vale excluí-la com
`--exclude-table-data=resultados`, já que o `agregados_hora` preserva o histórico
que interessa.

## Testes

160 testes, divididos entre lógica pura e integração contra o Postgres de
verdade. Os que valem menção:

- **Guarda de rede** (34): uma tabela de endereços internos e públicos, incluindo
  os disfarces 6to4, NAT64 e IPv4 mapeado em IPv6.
- **Executor**: sobe servidor HTTP real e troca só a peça de resolução de
  endereço, porque a guarda recusa loopback de propósito — todo o resto do
  caminho de produção continua rodando. Cobre gzip, corte de corpo, timeout,
  redirecionamento para rede interna e credencial que não viaja entre hosts.
- **Concorrência do agendador**: não se contenta com dois workers em paralelo,
  que podem serializar e passar à toa. O teste segura o lock numa transação
  aberta e exige que a reserva devolva as outras linhas em menos de um segundo.
  Conferi que ele estoura por timeout se o `skipLocked()` for removido.
- **Incidente**: sobe e desce nas bordas exatas, alvo instável que alterna sem
  nunca abrir, sucesso no meio da queda adiando a abertura, falha no meio da
  recuperação segurando o fechamento, e quatro aberturas em paralelo gerando um
  incidente só.
- **Uptime**: agregação repetida sem duplicar, resultado atrasado reescrevendo a
  hora, hora em andamento que não é agregada, retenção preservando o agregado.
- **Alerta ponta a ponta**: seis checks com o alvo fora geram um aviso, não seis.

Além da suíte, o fluxo foi verificado com os processos reais rodando contra a
internet — é assim que apareceu um erro que os testes não pegavam: host
inexistente vinha marcado como `bloqueado`, o que manda procurar problema na
guarda de SSRF quando o que existe é um host errado no cadastro. Virou `conexao`,
com classe de erro própria.
