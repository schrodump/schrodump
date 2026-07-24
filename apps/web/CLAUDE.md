# @schrodump/web

Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui + TanStack Query + Zod. Consome a
API de `apps/server`. Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes

- **O estado do backup é ternário e a cor é conteúdo, não decoração.** `VERIFIED` verde,
  `UNOBSERVED` âmbar, `FAILED` vermelho. Não existe "OK", não existe cinza para não verificado, e
  o contador primário do painel é _"N backups não observados"_ — nunca "N ok". Ver `StatusBadge`
  e `state-counters.tsx`, e a tese na raiz.
- **Credencial é write-only na UI.** Valor do servidor nunca chega ao front, nunca preenche
  campo. Configurado → mostra "configurado" + permite substituir. Ver `CredentialField`.
- **Restore tem atrito de propósito.** Escopos que a engine não suporta ficam desabilitados com o
  motivo (matriz em `lib/domain.ts`); sobrescrever banco existente exige digitar o nome do banco.
  Viewer não vê o botão — e o servidor recusa mesmo assim (a UI é a segunda tranca, não a única).
- **Verify desligado numa policy é aviso persistente**, não toast.
- **Nenhuma string literal de UI em componente.** Tudo em `src/i18n/messages/en.ts` (fonte das
  chaves); cada tradução — `pt-BR.ts` e `es.ts` — é um `Record<MessageKey, string>`, então tradução
  faltando quebra o typecheck. Adicionar locale: novo dicionário + entrada em `Locale`/`LOCALES`/
  `dictionaries` no `provider.tsx`. Chaves dinâmicas usam template literal
  (`` t(`job.state.${state}`) ``), que o TS estreita para o subconjunto válido.
- **Sessão é cookie**, nunca localStorage. Só a preferência de idioma vai pro localStorage.

## Como fala com o servidor

Não há CORS: o `next.config.ts` faz rewrite de `/api/auth/*` e `/backend/*` para
`SCHRODUMP_API_URL`. Todo fetch é same-origin com `credentials: "include"`. O valor é assado no
build (`output: "standalone"`), não lido em runtime — na imagem, a API escuta em `127.0.0.1:8081`.

## Domínio e formatação

- `src/lib/domain.ts` é um espelho manual do vocabulário de `@schrodump/core` (enums pequenos e
  estáveis) — o web **não** depende de pacote do workspace, o que mantém o build do Next limpo.
  Mudou enum no core, atualize aqui.
- **Números do servidor não vão crus para a tela.** `serverVersionNum` é inteiro codificado
  (`70015` = MongoDB 7.0.15); sempre passe por `formatServerVersion`. Tamanhos por `formatBytes`.

## Test-connection e RBAC

- O probe retorna `{ ok, serverVersionNum, failure, driverCode }`. `failure` é um código
  (`UNREACHABLE`/`TIMEOUT`/`AUTH_FAILED`/`INSUFFICIENT_PRIVILEGES`/`TLS_FAILED`/`UNKNOWN`) com
  texto em `targets.probe.reason.*`. O `driverCode` só é mostrado quando `failure === "UNKNOWN"`
  — nos outros casos é ruído.
- **Role falha fechado.** `useCurrentRole` lê a role da sessão; como nenhum endpoint a expõe
  ainda, retorna `viewer` por default — o que **esconde o restore de todos** no app rodando. É
  intencional: o servidor é quem impõe `operator+`. Destrava sozinho quando o endpoint existir.

## URL de conexão (`lib/connection-url.ts`)

Colar uma URL **preenche** o formulário de alvo; nunca é enviada ao servidor nem armazenada — a
credencial tem um caminho só, e ele não passa por aqui. Parse client-side com o `URL` do WHATWG.
No sucesso o campo é limpo (não guardar a senha em dois lugares do estado); no erro, nenhum campo
é tocado. Recusa com motivo `mongodb+srv` e URIs multi-host em vez de chutar.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
