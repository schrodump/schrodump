# @schrodump/storage

Driver S3-compatible. Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes

- Importa **apenas** `@schrodump/core`, o AWS SDK (`@aws-sdk/client-s3`,
  `@aws-sdk/lib-storage`) e `zod` (schema da config). **Nunca** importa `engines` nem
  `runner`. Não conhece Docker, não conhece banco, não monta pipeline — quem compõe o
  pipe é o `apps/server`.
- Destino **S3-compatible apenas** no v1. Alvos: AWS S3, Cloudflare R2, Backblaze B2,
  MinIO, SeaweedFS, Ceph RGW.
- **Nenhuma credencial** em log, em mensagem de erro ou em `toString()`/serialização. O
  driver não retém campo de credencial; use `redactConfig` para descrever o destino.

## Lifecycle rule no bucket é PROIBIDO

> Retenção é resolvida pela aplicação (`@schrodump/core`), que conhece a cadeia
> `dependsOn`. Uma regra de expiração (lifecycle) no bucket **não** conhece essa cadeia
> e apaga o full deixando incrementais órfãos — perda total de dados.

Não configure expiração no bucket. A deleção é sempre explícita, comandada pela
aplicação depois de `resolveRetention`.

## Canary (`canary.ts`)

Exercita **PUT → GET → DELETE** contra um objeto descartável sob o prefixo real configurado, e
reporta qual passo falhou. O DELETE faz parte de propósito: validar só a credencial (ou só
PUT+GET) deixa passar uma chave com `s3:PutObject` mas sem `s3:DeleteObject` — backups rodam por
meses e a retenção falha silenciosa. É a mesma tese do verify aplicada ao destino: uma
credencial que escreve mas não gerencia produz um backup que você não consegue reter.

## `forcePathStyle`

É configuração **explícita** do usuário, não detecção automática. Obrigatório em MinIO,
SeaweedFS e Ceph RGW; R2 e B2 aceitam virtual-hosted.

## SPDX

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
