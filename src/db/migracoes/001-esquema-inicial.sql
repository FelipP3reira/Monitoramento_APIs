create table monitores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  url text not null,
  metodo text not null default 'GET'
    check (metodo in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
  cabecalhos_cifrados text,
  corpo text,
  intervalo_segundos integer not null check (intervalo_segundos between 10 and 86400),
  timeout_ms integer not null default 5000 check (timeout_ms between 100 and 60000),
  status_esperado integer[] not null default '{200}',
  latencia_maxima_ms integer check (latencia_maxima_ms > 0),
  assertivas jsonb not null default '[]'::jsonb,
  falhas_para_abrir smallint not null default 3 check (falhas_para_abrir between 1 and 20),
  sucessos_para_fechar smallint not null default 2 check (sucessos_para_fechar between 1 and 20),
  ativo boolean not null default true,
  proximo_check_em timestamptz not null default now(),
  reservado_ate timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- O worker so olha monitores ativos e vencidos; o indice parcial mantem a fila pequena
-- mesmo com muito monitor desligado.
create index monitores_fila on monitores (proximo_check_em) where ativo;

create table resultados (
  id bigserial primary key,
  monitor_id uuid not null references monitores (id) on delete cascade,
  verificado_em timestamptz not null default now(),
  sucesso boolean not null,
  codigo_http integer,
  latencia_ms integer,
  motivo_falha text
    check (motivo_falha in ('conexao', 'timeout', 'status', 'latencia', 'assertiva', 'bloqueado')),
  detalhe text,
  constraint falha_tem_motivo check (
    (sucesso and motivo_falha is null) or (not sucesso and motivo_falha is not null)
  )
);

create index resultados_por_monitor on resultados (monitor_id, verificado_em desc);

-- BRIN em vez de btree: a tabela cresce sempre em ordem de tempo, entao o indice
-- de faixa cabe em alguns kilobytes onde o btree custaria centenas de megabytes.
create index resultados_periodo on resultados using brin (verificado_em);

create table agregados_hora (
  monitor_id uuid not null references monitores (id) on delete cascade,
  hora timestamptz not null,
  total integer not null,
  sucessos integer not null,
  latencia_p50 integer,
  latencia_p95 integer,
  latencia_maxima integer,
  primary key (monitor_id, hora)
);

create table incidentes (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitores (id) on delete cascade,
  aberto_em timestamptz not null default now(),
  fechado_em timestamptz,
  motivo text not null,
  detalhe text,
  falhas integer not null default 0,
  constraint fechamento_depois_da_abertura check (fechado_em is null or fechado_em >= aberto_em)
);

-- A garantia de que dois workers nunca abrem dois incidentes para o mesmo monitor
-- mora aqui, no banco, e nao na aplicacao.
create unique index incidentes_um_aberto_por_monitor on incidentes (monitor_id)
  where fechado_em is null;

create index incidentes_por_monitor on incidentes (monitor_id, aberto_em desc);

create table canais_alerta (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid references monitores (id) on delete cascade,
  tipo text not null check (tipo in ('email', 'webhook')),
  destino text not null,
  segredo_cifrado text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create index canais_por_monitor on canais_alerta (monitor_id) where ativo;

create table alertas_enviados (
  id bigserial primary key,
  incidente_id uuid not null references incidentes (id) on delete cascade,
  canal_id uuid not null references canais_alerta (id) on delete cascade,
  evento text not null check (evento in ('abriu', 'fechou')),
  -- O anti-spam de verdade: (incidente, evento, canal) so entra uma vez.
  chave_idempotencia text not null unique,
  situacao text not null default 'pendente'
    check (situacao in ('pendente', 'enviado', 'falhou')),
  tentativas smallint not null default 0,
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz
);

create index alertas_pendentes on alertas_enviados (criado_em) where situacao = 'pendente';
