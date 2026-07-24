# Schrodump — instruções raiz

Ferramenta open source de agendamento e verificação de backups **lógicos** de banco
(PostgreSQL, MySQL/MariaDB, MongoDB). Docker-first, agentless, destino S3-compatible.
Titular dos direitos: **ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA** (CNPJ
34.292.395/0001-65), licença **AGPL-3.0-or-later**.

## A tese (o que torna este projeto diferente de um cron com `pg_dump`)

**Um backup não é confiável até que um restore o tenha verificado.** Um job que sai com
código 0 provou uma coisa só: um processo rodou sem reclamar. Não provou que o arquivo no
bucket contém os dados. Todo artefato está em **um de três estados**, e a cor é conteúdo:

- **`VERIFIED`** (verde) — algo abriu e conferiu. Restaura.
- **`UNOBSERVED`** (âmbar, nunca cinza, nunca verde) — foi escrito, ninguém olhou. É o
  **default**. Pode estar perfeito ou vazio.
- **`FAILED`** (vermelho) — foi conferido e não presta.

Não existe "OK". O painel lidera pelo número de **não observados** — as perguntas em aberto —
não pelo número de sucessos. Qualquer decisão de UI, API ou domínio que borre essa distinção
está errada. Ver `docs/backup-restore.md` para o racional completo.

## Stack

- **Runtime:** Node.js 22 (ver `.nvmrc`)
- **Linguagem:** TypeScript ESM. A raiz e os pacotes usam `moduleResolution: nodenext`,
  `verbatimModuleSyntax`. O `apps/web` usa `bundler` (exigência do Next).
- **Package manager:** pnpm (ver `packageManager` no `package.json`)
- **Test runner:** Vitest (ESM nativo, sem transform)
- **Lint/format:** ESLint flat config + Prettier

## Mapa do workspace

```
packages/core       # domínio puro, sem I/O. Só depende de zod.
packages/engines    # descritores + probe por engine (o QUE executar)
packages/runner     # execução via Docker + scratch (ONDE executar)
packages/storage    # driver S3-compatible
apps/server         # Fastify + Prisma. Compõe os quatro pacotes acima.
apps/web            # Next.js 16 + React 19. Consome a API do server.
docker/             # Dockerfile de produção + executores (age, mydumper)
docs/               # install, security, backup-restore, lgpd, roadmap
.github/workflows/  # ci, security, release, cla
compose.yaml        # stack de deploy (server + postgres + docker-socket-proxy)
```

Cada pacote/app tem seu **próprio `CLAUDE.md`**, e ele **prevalece sobre este** dentro do seu
diretório. Esta raiz vale para o que não for sobrescrito.

## Grafo de dependência

Respeite estritamente — a CI e o review vão cobrar:

- `packages/core` — não importa nenhum outro pacote do workspace.
- `packages/engines`, `packages/runner`, `packages/storage` — importam **apenas** `core`,
  e **nunca** uns aos outros.
- `apps/*` — compõem os pacotes acima; são o único lugar onde eles se encontram.
- `apps/web` **não** importa pacote do workspace: reimplementa o vocabulário de domínio em
  `src/lib/domain.ts` (ver o `CLAUDE.md` dele).

## Como verificar (sem evidência, não está pronto)

Da raiz, rodando em todo o workspace:

```
pnpm typecheck      # tsc --noEmit por pacote (+ prisma generate no server)
pnpm lint           # eslint
pnpm test           # vitest run — unitários; pula os de integração por default
pnpm build          # tsc dos pacotes + next build do web
```

Os testes de **integração** (bancos reais via testcontainers, S3 real) só rodam com env
setado — são `describe.skipIf` de outra forma:

- `SCHRODUMP_TEST_INTEGRATION=1` — habilita probe (testcontainers) e runner (dockerode).
- `SCHRODUMP_TEST_S3_ENDPOINT` (+ `_ACCESS_KEY`/`_SECRET_KEY`/`_BUCKET`) — habilita o driver S3
  contra MinIO. Ver `.github/workflows/ci.yml`.

## Imagem e deploy

- `docker/Dockerfile` — imagem única (API Fastify + UI Next), multi-stage, Node alpine pinado
  por patch, usuário não-root, `dumb-init` como PID 1, `prisma migrate deploy` no entrypoint.
  **Sem nenhum client de banco dentro** — dump/restore rodam em executores efêmeros. Alvo de
  tamanho e a poda de dependências (`docker/prune-store.mjs`) estão documentados lá.
- `docker/executors/` — `age.Dockerfile` e `mydumper.Dockerfile`, versão **e digest** pinados.
- CI: `ci.yml` (check + integração + build/smoke da imagem), `security.yml` (audit, Trivy,
  gitleaks, SPDX), `release.yml` (multi-arch, cosign, SBOM em tag `v*`), `cla.yml`
  (**desabilitado** até o texto do CLA sair de `TODO` em `CONTRIBUTING.md`).
- `docs/roadmap.md` registra o que ficou **fora do v1** e por quê (backup físico/PITR, agent em
  Go, Object Lock, notificações) e as **limitações conhecidas** que embarcam no v1.

## Header SPDX (obrigatório)

Todo arquivo-fonte começa com — inclusive `Dockerfile`, workflows e `.mjs`:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```

A única exceção rastreada é `apps/web/next-env.d.ts`, regenerado pelo `next build`. O job `spdx`
do `security.yml` cobra o resto.
