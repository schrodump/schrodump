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

> **`SIGTERM` gracioso:** o server instala o handler (`jobs/shutdown.ts`), não o runner. No sinal:
> para de reivindicar novos jobs, aborta o `AbortSignal` compartilhado — o que faz o `run()`/
> `withEphemeralService()` em andamento (Task 1) matar o container à força e rejeitar
> `RUNNER_ABORTED` — espera o tick assentar (`whenIdle()`, Task 2) sob um budget
> (`SCHRODUMP_SHUTDOWN_GRACE_MS`, default 8s) e só então desconecta. O `finally` do executor libera
> a reserva de scratch nesse abort do mesmo jeito que libera num erro comum, então o dump em claro
> de um job interrompido normalmente **é removido no shutdown**, não só na próxima varredura.
> Residual: um `SIGKILL` que chega antes do grace expirar (ou antes do handler terminar) pula esse
> caminho inteiro — aí a varredura de boot (`sweep`, por idade) continua sendo o backstop. Ver
> `docs/roadmap.md` e `docs/security.md`.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
