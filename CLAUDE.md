# Schrodump — root instructions

Ferramenta open source de agendamento e verificação de backups **lógicos** de banco
(PostgreSQL, MySQL/MariaDB, MongoDB). Docker-first, agentless, destino S3-compatible.

## Stack

- **Runtime:** Node.js 22 (ver `.nvmrc`)
- **Linguagem:** TypeScript ESM (`module`/`moduleResolution: nodenext`, `verbatimModuleSyntax`)
- **Package manager:** pnpm (ver `packageManager` no `package.json`)
- **Test runner:** Vitest (ESM nativo, sem transform)
- **Lint/format:** ESLint flat config + Prettier

## Escopo por pacote

Cada pacote/app tem seu **próprio `CLAUDE.md`**, e ele **prevalece sobre este** dentro
do seu diretório. Esta raiz vale apenas para o que não for sobrescrito.

## Grafo de dependência

Respeite estritamente — a CI e o review vão cobrar:

- `packages/core` — não importa nenhum outro pacote do workspace.
- `packages/engines`, `packages/runner`, `packages/storage` — importam **apenas** `core`,
  e **nunca** uns aos outros.
- `apps/*` — compõem os pacotes acima; são o único lugar onde eles se encontram.

## Header SPDX (obrigatório)

Todo arquivo-fonte começa com:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
