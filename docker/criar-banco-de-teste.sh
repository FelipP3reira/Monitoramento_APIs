#!/bin/sh
# A suite de testes precisa de um banco separado para poder truncar tabelas a vontade.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
  CREATE DATABASE monitoramento_teste OWNER $POSTGRES_USER;
SQL
