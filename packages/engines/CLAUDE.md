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

## Imagens executoras

- postgres: `postgres:<major>-alpine` (13–18); `pg_dump` ≥ versão do servidor.
- mysql/mariadb: `mysql:<maj.min>` / `mariadb:<maj.min>`; STAGED usa `schrodump/mydumper` (própria).
- mongodb: `mongo:<major>` **oficial** — verificado que já embarca `mongodump`/`mongorestore`.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
