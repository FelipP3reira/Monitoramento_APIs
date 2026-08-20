-- O reenvio com espera crescente precisa saber quando tentar de novo; sem essa
-- coluna o despachante so saberia "pendente" e reenviaria em rajada.
alter table alertas_enviados
  add column proxima_tentativa_em timestamptz not null default now();

drop index alertas_pendentes;

create index alertas_pendentes on alertas_enviados (proxima_tentativa_em)
  where situacao = 'pendente';
