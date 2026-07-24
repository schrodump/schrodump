# @schrodump/server

Fastify + Prisma + PostgreSQL. Compõe `@schrodump/core`, `engines`, `runner` e `storage` —
é o único lugar onde esses quatro se encontram. Prevalece sobre o `CLAUDE.md` da raiz aqui.

## Estrutura

- `routes/` — HTTP. Cada rota valida com Zod e chama um store/serviço. `wiring.ts` monta os
  stores reais (scopedPrisma) e o `JobsService`.
- `jobs/` — lógica de cada job (backup, verify, restore, retention, catalog-rebuild,
  self-backup) como funções + o `-wiring.ts` que as liga ao Prisma/runner/storage.
- `scheduler/` — avalia policies e cria jobs. É **processo de sistema**, não requisição de
  tenant: é o **único lugar** com query cross-organization. Idempotente por
  `(policyId, scheduledAt)`; recuperação de órfãos marca `RUNNING → FAILED` no boot.
- `crypto/` — os três domínios de cripto (abaixo). `probe/` — teste de conexão real.
- `auth/` — better-auth (`auth.ts`) + RBAC (`rbac.ts`). `data/scope.ts` — o `scopedPrisma`.

## Invariantes

- **Todo modelo de domínio carrega `organizationId`.** Sem exceção, inclusive em rota interna.
  O acesso é sempre via `scopedPrisma(orgId)` (client extension que injeta `organizationId`);
  esquecer o filtro é impossível, não só difícil. A exceção é o scheduler, acima.
- **Toda entrada de rota passa por Zod antes do Prisma.** O vetor é objeto não validado indo
  para `where` — `express-mongo-sanitize` e afins NÃO protegem o Prisma.
- **Credencial é write-only da perspectiva do usuário.** Nunca é decriptada para **exibir**.
  Ver a exceção deliberada em "Probe", abaixo: decriptar para **usar** é outra coisa.
- **Nenhum segredo em log, em nenhum nível** (inclusive `debug`). `observability/pino.ts` faz
  redaction de `password`/`secret`/`secretAccessKey` (e `*.` deles); a convenção reforça.
- `viewer` **não** dispara restore — requisito de auditoria. A rota exige `operator+`; a UI
  esconder o botão é a segunda tranca, não a única.

## Probe / test-connection (`probe/test-connection.ts`)

- **É o único lugar que decripta a credencial de um alvo** — e decripta para **usar** (entregar
  a um driver que abre socket), nunca para exibir. O texto claro não sai da chamada da função;
  nada derivado dele entra na resposta nem no log.
- **Classifica pelo CÓDIGO do erro do driver, nunca pela mensagem.** Erro de driver embute a
  credencial que falhou (o driver do Mongo põe a URI inteira, senha inclusa, no texto). O que
  sai é uma das constantes `ProbeFailureCode`. A única exceção: quando a classificação desiste
  (`UNKNOWN`), o resultado carrega `driverCode` — só classe + código do erro (`ERROR/18`),
  que não têm como carregar segredo — para o `UNKNOWN` não ser um beco sem saída.
- Ler a mensagem para desempatar é permitido (o driver do Mongo reporta falha de conexão sem
  código); **emitir** a mensagem não é. A distinção está comentada no arquivo.
- `serverVersionNum` é inteiro codificado (`major*10000 + minor*100 + patch`) — chave de
  comparação, não texto. Formatar para exibição é do `apps/web`.

## Env (o que o server realmente lê)

`env.ts` valida com Zod e lê **apenas**: `DATABASE_URL`, `PORT`, `SCHRODUMP_KEK`,
`SCHRODUMP_URL`, `SCHRODUMP_ADMIN_EMAIL`, `SCHRODUMP_ADMIN_PASSWORD`. Os `ADMIN_*` são
`min(1)` — passar string vazia é valor **inválido**, não "não setado", e derruba o boot;
deixe-os ausentes para criar o admin pelo link de setup.

> **Gap:** o `compose.yaml` passa `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_SCRATCH_MAX_BYTES`,
> `SCHRODUMP_MAX_CONCURRENT_STAGED`, `SCHRODUMP_EXECUTOR_NETWORK` e `DOCKER_HOST` — que o
> `env.ts` **ainda não lê**. A wiring de scratch/executor do worker consome isso quando entrar.

## Prisma

- **Prisma 6** (o 7 exige driver adapter + `prisma.config.ts`; adiado). Generator
  `prisma-client-js`, client em `@prisma/client`.
- `prisma generate` roda nos scripts `typecheck`/`test` (não precisa de DB).
- Migrações reversíveis, revisadas antes de aplicar; `prisma migrate diff` limpo. Em produção,
  o entrypoint da imagem roda `prisma migrate deploy` antes de o server escutar.
- **BigInt e JSON:** o Prisma devolve `BigInt` para colunas como `sizeRawBytes`. O Fastify não
  serializa `BigInt` por padrão. `policies` já converte via `toPolicyRecord`; a rota
  `GET /artifacts` devolve a linha crua e **vai estourar quando existir um artefato** — mapear
  antes de serializar é obrigatório para qualquer rota que exponha BigInt.

## Criptografia (3 domínios, não misturar)

1. **Credenciais de metadados** — envelope: DEK por credencial, envelopada pela KEK
   (`SCHRODUMP_KEK`). Decriptação em `crypto/envelope.ts`.
2. **Fingerprint da KEK** — SHA-256 de material derivado (nunca a chave), gravado no `AppConfig`
   no 1º boot; boot falha se divergir. É por isso que trocar a KEK contra um banco existente
   recusa o boot em vez de gerar artefatos que ninguém abre.
3. **Artefatos** — `age` (binário via runner, execução diferida), sempre 2 recipients
   (operacional + escrow). Pipeline: dump → compressão → criptografia (nunca inverter).

## Gaps conhecidos (ver `docs/roadmap.md`)

- Restore retorna **501**: a execução (dump→compress→encrypt→upload consumindo jobs `PENDING`)
  ainda não está ligada. Orquestração existe como função pura; o loop consumidor não.
- **Não há endpoint que exponha a role do usuário corrente** — a role vem do membership
  resolvido em `auth/auth.ts`, não da sessão. O front falha fechado em `viewer`.
- **Alvo é imutável:** só `POST`/`GET` em `/targets`, sem editar nem excluir.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
