# @schrodump/web

Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui. Consome a API de `apps/server`.
Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes

- **O estado do backup é ternário e a cor é conteúdo, não decoração.** `VERIFIED` verde,
  `UNOBSERVED` âmbar, `FAILED` vermelho. Não existe "OK", não existe cinza para não verificado, e
  o contador primário do dashboard é _"N backups não observados"_ — nunca "N ok".
- **Credencial é write-only na UI.** Valor do servidor nunca chega ao front, nunca preenche
  campo. Configurado → mostra "configurado" + permite substituir. Ver `CredentialField`.
- **Restore tem atrito de propósito.** Escopos que a engine não suporta ficam desabilitados com o
  motivo (matriz em `lib/domain.ts`); sobrescrever banco existente exige digitar o nome do banco.
  Viewer não vê o botão — e o servidor recusa mesmo assim (a UI é a segunda tranca, não a única).
- **Verify desligado numa policy é aviso persistente**, não toast.
- **Nenhuma string literal de UI em componente.** Tudo em `src/i18n/messages/en.ts`; `pt-BR.ts` é
  `Record<MessageKey, string>`, então tradução faltando quebra o typecheck.
- **Sessão é cookie**, nunca localStorage. Só a preferência de idioma vai pro localStorage.

## Como fala com o servidor

Não há CORS: o `next.config.ts` faz rewrite de `/api/auth/*` e `/backend/*` para
`SCHRODUMP_API_URL`. Todo fetch é same-origin com `credentials: "include"`.

## Domínio

`src/lib/domain.ts` é um espelho manual do vocabulário de `@schrodump/core` (enums pequenos e
estáveis) — o web não depende de pacote do workspace, o que mantém o build do Next limpo. Mudou
enum no core, atualize aqui.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
