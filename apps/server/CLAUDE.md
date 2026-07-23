# @schrodump/server

Fastify + Prisma + PostgreSQL. Compõe `@schrodump/core`, `engines`, `runner` e `storage`.
Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes

- **Todo modelo de domínio carrega `organizationId`.** Sem exceção, inclusive em rota interna.
  O acesso é sempre via `scopedPrisma(orgId)` (client extension que injeta `organizationId`);
  esquecer o filtro é impossível, não só difícil.
- **Toda entrada de rota passa por Zod antes do Prisma.** O vetor é objeto não validado indo
  para `where` — `express-mongo-sanitize` e afins NÃO protegem o Prisma.
- **Credencial é write-only** da perspectiva do usuário. Nunca decripta para exibir na UI.
- **Nenhum segredo em log, em nenhum nível** (inclusive `debug`). Redaction do pino + convenção.
- `viewer` **não** dispara restore — requisito de auditoria, não conveniência.

## Prisma

- **Prisma 6** (o 7 exige driver adapter + `prisma.config.ts`; adiado). Generator
  `prisma-client-js`, client em `@prisma/client`.
- `prisma generate` roda nos scripts `typecheck`/`test` (não precisa de DB).
- Migrações reversíveis, revisadas antes de aplicar; `prisma migrate diff` limpo.

## Criptografia (3 domínios, não misturar)

1. **Credenciais de metadados** — envelope: DEK por credencial, envelopada pela KEK
   (`SCHRODUMP_KEK`).
2. **Fingerprint da KEK** — SHA-256 de material derivado (nunca a chave), gravado no `AppConfig`
   no 1º boot; boot falha se divergir.
3. **Artefatos** — `age` (binário via runner, execução diferida), sempre 2 recipients
   (operacional + escrow). Pipeline: dump → compressão → criptografia (nunca inverter).

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
