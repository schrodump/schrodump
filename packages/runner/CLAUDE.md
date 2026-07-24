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

> **Gap conhecido:** não há handler de `SIGTERM`/`SIGINT` no runner nem no server. O sinal chega
> (o `dumb-init` entrega, o shutdown é limpo), mas o processo sai na hora e o scratch de um job
> em andamento **não é liberado no shutdown** — só na varredura do próximo boot (`sweep`, por
> idade). A janela em que o dump fica em claro é essa. Corrigir é instalar o handler que aciona o
> delete antes de sair. Ver `docs/roadmap.md` e `docs/security.md`.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
