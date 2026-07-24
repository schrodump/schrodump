# @schrodump/engines

Descritores e probe por engine. Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes

- Importa **apenas** `@schrodump/core` e os drivers de banco usados no probe (`pg`, `mysql2`,
  `mongodb`). **Nunca** importa `storage` nem `runner`.
- Responsabilidade: dizer **o que** executar (descritores). **Não executa nada** — quem
  executa é o `runner`.
- **Regra de ouro:** adicionar uma engine (MariaDB separado, futuros) é uma **entrada de
  tabela** no `registry.ts`, nunca um `if (engine === ...)` novo espalhado. O único dispatch
  por engine é o `Record<EngineKind, EngineAdapter>` do registry; `if`/`switch` por engine só
  dentro de um adapter.

## Credenciais

- **Jamais** em `command` — argv é visível para qualquer processo do host. Vai só em `env`
  (`PGPASSWORD`, `MYSQL_PWD`) ou arquivo de config montado (mongo, via `--config`).
- Probe: `tls: true` (require) por padrão; desligar TLS é **opção explícita** do alvo, nunca
  fallback silencioso. Timeout de conexão é obrigatório em todo probe.

## Probe — o que não é óbvio

- No MongoDB, o campo `database` da `ProbeConnection` é o **authSource** (`admin`), não o banco
  a copiar. Passar o escopo ali autentica contra o banco errado e falha com credencial correta.
- O `probeMongodb` chama `listDatabases()`, que exige **privilégio de cluster**. Um usuário de
  backup comum autentica e leva `Unauthorized` (código 13). Tensão de design registrada: testar
  conexão hoje pede mais privilégio do que o backup de um banco único precisaria.
- **Classificar erro de driver é responsabilidade do `apps/server`** (`probe/test-connection.ts`),
  não daqui. O probe pode propagar o erro cru — o server é que traduz para código sem vazar
  credencial. Não engula nem reescreva o erro aqui.

## Imagens executoras

- postgres: `postgres:<major>-alpine` (13–18); `pg_dump` ≥ versão do servidor.
- mysql/mariadb: `mysql:<maj.min>` / `mariadb:<maj.min>`; STAGED usa `schrodump/mydumper` (própria).
- mongodb: `mongo:<major>` **oficial** — verificado que já embarca `mongodump`/`mongorestore`.

As imagens `schrodump/*` referenciadas por tag flutuante aqui (`schrodump/mydumper:1`) são
construídas com versão **e digest** pinados em `docker/executors/` e publicadas pelo `release.yml`.
Mudar a referência da tag é código de aplicação, não de infra.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
