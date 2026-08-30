# @schrodump/runner

Execução via Docker e gestão de scratch. Prevalece sobre o `CLAUDE.md` da raiz aqui.

## Invariantes

- Importa **apenas** `@schrodump/core`. **Nunca** importa `engines` nem `storage`.
- Divisão de responsabilidade: `engines` diz **o que** executar (imagem, comando, args);
  o runner diz **onde**. Hoje existe só `DockerRunner`; quando o backup físico entrar,
  `AgentRunner` implementa a mesma `Runner` sem tocar em `engines`.
- O runner **não conhece o destino** do stream. Ele expõe a saída; quem conecta ao storage
  é o `apps/server`. Manter essa fronteira.

## Execução (docker.ts) — o que quebra em silêncio

- **Exit code** sempre por `container.wait().StatusCode`, nunca por EOF do stdout. Sucesso
  só com `StatusCode === 0`.
- **Sem `AutoRemove`**: remover o container manualmente no `finally`, depois de ler exit code
  e stderr.
- **Rede** sempre explícita (`RunOptions.network`), nunca herdada. Rede inexistente → erro
  claro, nunca roda na default.
- **Timeout** obrigatório: ao estourar, mata o container e propaga erro tipado. Cancelamento
  do usuário também mata o container.
- **stderr** sempre capturado, truncado e **sanitizado** (mensagens de client de banco vazam
  host/usuário/senha).

## Scratch (scratch.ts)

> O scratch contém **dump em claro**. No modo `directory` quem escreve é o próprio
> `pg_dump`/`mydumper`, então não dá para cifrar inline. Mitigação: volume dedicado, `0700`,
> delete no `finally`, e **filesystem cifrado no host** — este último é responsabilidade do
> operador e precisa estar na documentação de deploy.

> **Shutdown cancellation:** `RunOptions.signal` and the third parameter of `withEphemeralService`
> accept an `AbortSignal`. On abort the runner kills the container through **the same path the
> timeout already uses**, `run()` rejects with `RUNNER_ABORTED`, and the executor's `finally`
> releases the scratch reservation — so the cleartext dump does not survive a `docker stop`. An
> aborted `withEphemeralService` waits for its `use` callback to unwind before removing the sandbox
> (bounded by `SERVICE_ABORT_UNWIND_MS`), so that inner cleanup is never left running detached
> behind a caller that already believes it is done. The handler that trips the abort lives in the
> server (`server.ts`), bounded by `SCHRODUMP_SHUTDOWN_GRACE_MS` — and the orchestrator's own stop
> grace has to exceed that by a few seconds, or the `SIGKILL` lands mid-cleanup. Residual, known
> cases rather than a complete list: a `SIGKILL` that beats the grace, a Docker daemon that hangs
> during teardown, and a STAGED backup whose scratch release is waiting on an in-flight S3
> multipart upload (not cancellable today) to finalize. Those still rely on the sweep at the next
> boot.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
