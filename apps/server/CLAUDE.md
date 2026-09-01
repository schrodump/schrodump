# @schrodump/server

Fastify + Prisma + PostgreSQL. Compõe `@schrodump/core`, `engines`, `runner` e `storage` —
é o único lugar onde esses quatro se encontram. Prevalece sobre o `CLAUDE.md` da raiz aqui.

## Estrutura

- `routes/` — HTTP. Cada rota valida com Zod e chama um store/serviço. `wiring.ts` monta os
  stores reais (scopedPrisma) e o `JobsService`.
- `jobs/` — lógica de cada job (backup, verify, restore, retention, catalog-rebuild,
  self-backup) como funções + o `-wiring.ts` que as liga ao Prisma/runner/storage.
  A retenção é um `JobKind` (`RETENTION`), não uma varredura de fundo: apagar backup é desfecho que
  o operador precisa conseguir ler depois — inclusive quando o ciclo se recusou a rodar. Ela é
  encadeada pelo worker após um BACKUP **SUCCEEDED** da mesma policy (`jobs/worker.ts`), nunca por
  cron próprio; backup que falhou jamais custa uma cópia antiga.
- `scheduler/` — avalia policies e cria jobs. É **processo de sistema**, não requisição de
  tenant: lê policies cross-organization e escreve jobs `organizationId`-scoped. Idempotente por
  `(policyId, scheduledAt)`; recuperação de órfãos marca `RUNNING → FAILED` no boot. O worker
  (`jobs/claim.ts` + `jobs/worker-wiring.ts`) é o outro processo de sistema com o mesmo status.
- `crypto/` — os três domínios de cripto (abaixo). `probe/` — teste de conexão real.
- `auth/` — better-auth (`auth.ts`) + RBAC (`rbac.ts`). `data/scope.ts` — o `scopedPrisma`.

## Invariantes

- **Todo modelo de domínio carrega `organizationId`.** Sem exceção, inclusive em rota interna.
  O acesso é sempre via `scopedPrisma(orgId)` (client extension que injeta `organizationId`);
  esquecer o filtro é impossível, não só difícil. As exceções são os processos de sistema — o
  scheduler e o worker (`jobs/claim.ts`, `jobs/worker-wiring.ts`) —, que usam prisma cru e filtram
  `organizationId` explicitamente em cada query.
- **Toda entrada de rota passa por Zod antes do Prisma.** O vetor é objeto não validado indo
  para `where` — `express-mongo-sanitize` e afins NÃO protegem o Prisma.
- **Credencial é write-only da perspectiva do usuário.** Nunca é decriptada para **exibir**.
  Ver a exceção deliberada em "Probe", abaixo: decriptar para **usar** é outra coisa.
- **Nenhum segredo em log, em nenhum nível** (inclusive `debug`). `observability/pino.ts` faz
  redaction de `password`/`secret`/`secretAccessKey` (e `*.` deles); a convenção reforça.
- `viewer` **não** dispara restore — requisito de auditoria. A rota exige `operator+`; a UI
  esconder o botão é a segunda tranca, não a única.
- **Retenção nunca apaga por omissão.** Todo contador `keep*` tem default 0 — no Zod e na coluna —
  então "não configurei retenção" e "quero guardar zero cópias" chegam idênticos ao
  `resolveRetention`, que responde a segunda: apagar tudo. `retentionIsConfigured` (core) é a
  guarda obrigatória antes de agir sobre essa resposta, e `runRetention` a aplica antes de qualquer
  I/O. Silêncio não é instrução. Mesma regra para visão incompleta: manifesto ilegível ou órfão
  aborta o ciclo inteiro em vez de podar contra um retrato que já se sabe parcial.

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

`env.ts` valida com Zod. Além de `DATABASE_URL`, `PORT`, `SCHRODUMP_KEK`, `SCHRODUMP_URL`,
`SCHRODUMP_ADMIN_EMAIL`/`SCHRODUMP_ADMIN_PASSWORD` (e `BETTER_AUTH_SECRET`/`LOG_LEVEL`), agora lê
a config de worker/executor: `SCHRODUMP_SCRATCH_PATH`, `SCHRODUMP_SCRATCH_MAX_BYTES`,
`SCHRODUMP_MAX_CONCURRENT_STAGED`, `SCHRODUMP_EXECUTOR_NETWORK`, `WORKER_POLL_MS`,
`SCHRODUMP_SCHEDULER_TICK_MS`, `SCHRODUMP_SHUTDOWN_GRACE_MS`,
`SCHRODUMP_STAGED_THRESHOLD_BYTES` e o trio do self-backup
(`SCHRODUMP_SELF_BACKUP_DESTINATION_ID`, `_INTERVAL_MS`, `_NETWORK`). Scratch path
ausente ⇒ STREAM-only (sem staged/parallel). Os `ADMIN_*` são `min(1)` — passar string vazia é
valor **inválido**, não "não setado", e derruba o boot; deixe-os ausentes para criar o admin pelo
link de setup.

> **`SCHRODUMP_STAGED_THRESHOLD_BYTES` não tem default, e isso é a decisão.** STAGED é mais rápido
> num banco grande, mas escreve o dump em claro no disco antes de subir e exige o volume de scratch
> dimensionado para isso — então o modo não é escolhido POR conta do operador com base em tamanho.
> `parallelism > 1` na policy é o caminho explícito, por policy. Antes deste ajuste o limiar recebia
> `SCHRODUMP_SCRATCH_MAX_BYTES`, que é o **teto do volume**, não um limiar de roteamento: o efeito
> era só estagiar dumps maiores que todo o orçamento de scratch.

> **Nota:** `DOCKER_HOST` não passa pelo `env.ts` — o runner (dockerode) o lê direto do ambiente.

## Prisma

- **Prisma 6** (o 7 exige driver adapter + `prisma.config.ts`; adiado). Generator
  `prisma-client-js`, client em `@prisma/client`.
- `prisma generate` roda nos scripts `typecheck`/`test` (não precisa de DB).
- Migrações reversíveis, revisadas antes de aplicar; `prisma migrate diff` limpo. Em produção,
  o entrypoint da imagem roda `prisma migrate deploy` antes de o server escutar.
- **BigInt e JSON:** o Prisma devolve `BigInt` para colunas como `sizeRawBytes` e
  `minAgeBeforeDeleteMs`. O Fastify não serializa `BigInt` por padrão, e aritmética de `BigInt`
  contra `number` estoura em runtime. Mapear antes de serializar (ou antes de entregar ao `core`)
  é obrigatório: `policies` via `toPolicyRecord`, `GET /artifacts` via `toArtifactRecord`
  (`routes/wiring.ts`), retenção via `toRetentionPolicy` (`jobs/worker-wiring.ts`).

## Criptografia (3 domínios, não misturar)

1. **Credenciais de metadados** — envelope: DEK por credencial, envelopada pela KEK
   (`SCHRODUMP_KEK`). Decriptação em `crypto/envelope.ts`.
2. **Fingerprint da KEK** — SHA-256 de material derivado (nunca a chave), gravado no `AppConfig`
   no 1º boot; boot falha se divergir. É por isso que trocar a KEK contra um banco existente
   recusa o boot em vez de gerar artefatos que ninguém abre.
3. **Artefatos** — `age` **in-process** via a lib `age-encryption` (`Encrypter` no backup,
   `Decrypter` no restore; keygen pela mesma lib), sempre 2 recipients (operacional + escrow). Não
   há executor `age`: cifrar/decifrar num container exigia stdin sobre attach hijacked, cujo demux
   corrompia o stream. Pipeline: dump → compressão → criptografia (nunca inverter).

## Self-backup (`jobs/self-backup*.ts`)

- **Selado com a chave de ESCROW, e recusa rodar sem uma ativa.** A identidade da chave
  **operacional** mora, embrulhada pela KEK, **dentro do banco que o dump salva** — no desastre em
  que o self-backup seria usado, ela sumiu junto. Um artefato selado só para ela é chamariz: parece
  proteção e ninguém consegue abrir. `selectSelfBackupRecipients` lança em vez de escrever isso.
- **`SUCCEEDED` é `UNOBSERVED`, e a UI pinta âmbar.** Um `pg_dump` que saiu 0 é um processo que não
  reclamou. Verde aqui seria o único lugar do produto afirmando que um backup presta porque um job
  disse que sim.
- **O executor entra na rede `internal`, não na `SCHRODUMP_EXECUTOR_NETWORK`.** O banco de
  metadados é deliberadamente inalcançável a partir da rede onde correm os executores que falam com
  banco de cliente; esse é o único dump que precisa cruzar a linha, e cruza pela duração dele.
- **Vencimento é calculado pelo último run `SUCCEEDED`, nunca por timer de processo.** Um timer
  seria zerado a cada restart, e um self-backup diário num servidor reimplantado de hora em hora
  não rodaria nunca.
- **Loop e advisory lock próprios (`SCHRDMP3`).** Um dump de metadados leva minutos e o `startLoop`
  é single-flight — dobrá-lo dentro do tick do scheduler pararia o dispatch por esse tempo todo.
- **A linha na tabela nasce ANTES de resolver a configuração.** Destino apagado ou escrow ausente
  vira `SelfBackup` `FAILED` com motivo legível, visível em `GET /self-backups`, não só um log.

## Gaps conhecidos (ver `docs/roadmap.md`)

- **STAGED funciona nos dois sentidos, e três coisas precisaram entrar juntas.** O diretório de
  staging agora é **montado** no container do dump (antes o `-Fd` escrevia dentro do container e
  morria com ele), um segundo run faz `tar` daquele diretório para stdout (`buildArchiveStaging`),
  e o restore desempacota antes de entregar o diretório ao `pg_restore`/`myloader`
  (`buildExtractStaging`). Sem qualquer uma das três, o backup STAGED subia um artefato **vazio**
  com o job em `SUCCEEDED` — e como verify rebaixava para CHECKSUM, que passa nos ~318 bytes de
  cabeçalho, aquele artefato vazio podia chegar a `VERIFIED`. O `tar` vem da própria imagem da
  engine, não de um executor pinado: menos superfície de supply chain, ao custo de depender do
  busybox tar continuar lá.

- **Restore roda ponta a ponta para as quatro engines, nos dois modos de execução:** a rota
  enfileira, o worker despacha `RESTORE` e roda o pipeline real (download → decrypt in-process →
  gunzip → arquivo montado → `pg_restore`/`mysql`/`mongorestore`). Artefato `STAGED` passa por um
  passo a mais antes disso: o tar é desempacotado num diretório irmão no scratch, e é o **diretório**
  que vai montado — nunca o tar. O que falta: seleção de sub-escopo real para mysql/mongo (hoje
  sempre restore completo), e mongo está limitado a `FULL_CLUSTER` porque `mongorestore` roda com
  `--drop` sem `--nsInclude`.

- **Backup de mongo exige `SCHRODUMP_SCRATCH_PATH` configurado** — a senha do `mongodump`/
  `mongorestore` só viaja via arquivo `--config` montado (nunca argv/env), e esse arquivo precisa
  viver num caminho que o daemon Docker resolva (`RunMount.source`), i.e., o volume de scratch.
  Sem scratch configurado, backup de mongo falha alto e cedo (`MONGO_CONFIG_SCRATCH_REQUIRED_
REASON` em `jobs/worker-wiring.ts`) em vez de travar fundo no executor.
- **Recursos são editáveis, com campos de identidade retidos.** `/targets`, `/destinations` e
  `/policies` têm `PATCH` (operator+, schema `.strict()` e `.partial()`, patch vazio é 400). O que
  **não** se edita, e por quê — cada um invalidaria artefato já existente:
  `target.engine` (todo artefato registra a engine com que foi tirado), `destination.bucket`/
  `prefix` (as chaves dos artefatos são relativas a eles; repontar deixa o catálogo inteiro
  apontando para endereço vazio), `policy.targetId`/`destinationId` (a retenção raciocina por
  policy — repontar mistura dois bancos numa cadeia GFS e deixa os artefatos do destino antigo
  fora da retenção para sempre). Trocar isso é policy nova, não edição.
- **Segredo continua write-only no `PATCH`.** Omitir `password`/`secretAccessKey` mantém o
  armazenado — é o que torna possível editar host ou região sem reenviar um segredo que a UI nunca
  consegue ler de volta.
- **`DELETE` recusa com 409 e motivo quando algo depende da linha**, nunca cascateia. Destino com
  artefato é o caso afiado: a linha guarda a única credencial que o sistema tem daquele bucket, e
  apagá-la não apaga os backups — torna-os inalcançáveis. Policy é o caso traiçoeiro:
  `BackupJob.policy` é relação **opcional**, então o default do Prisma é `SetNull`, não `Restrict` —
  o banco aceitaria e zeraria `policyId` de todo job que ela rodou, deixando os artefatos
  inatribuíveis e invisíveis para a retenção sem nada parecer quebrado. Por isso a checagem é
  explícita, e a mensagem aponta `enabled: false` como a operação certa.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
