<div align="center">

# Schrodump

**Backups lógicos verificados para PostgreSQL, MySQL/MariaDB e MongoDB.**

Um backup que um restore não provou não é um backup — é um palpite.

[![Licença: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-brightgreen.svg)](.nvmrc)
[![CI](https://github.com/schrodump/schrodump/actions/workflows/ci.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/ci.yml)
[![Segurança](https://github.com/schrodump/schrodump/actions/workflows/security.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/security.yml)

[English](README.md) · **Português** · [Español](README.es.md)

</div>

---

## Por que Schrodump

Um job de backup que sai com código `0` provou uma coisa só: um processo rodou sem reclamar. **Não**
provou que o arquivo no seu bucket contém os dados. Uma credencial que escreve mas não lê, um dump
truncado quando a conexão caiu, uma regra de retenção que apagou a última cópia boa — todos produzem
um job verde e um artefato inútil, observável só na hora do restore.

Por isso o Schrodump se recusa a chamar um backup de bom só porque o job teve sucesso. Todo artefato
está em **um de três estados**, e a cor é conteúdo, não decoração:

| Estado | | Significado |
| --- | --- | --- |
| 🟢 **VERIFIED** | verde | Algo abriu e conferiu. Restaura. |
| 🟡 **UNOBSERVED** | âmbar | Foi escrito; ninguém olhou dentro. Pode estar perfeito, ou vazio. **É o default.** |
| 🔴 **FAILED** | vermelho | Foi conferido e não presta. |

Não existe "OK". O painel lidera pelo número de backups **não observados** — as perguntas em aberto
— não pelo número de jobs que tiveram sucesso. Essa inversão é o produto inteiro.

## Recursos

- **Restore verificado** — checksum, ou um restore completo num banco descartável, por política.
- **Agentless** — nada é instalado no host do seu banco. Os dumps rodam em contêineres efêmeros
  construídos a partir da major version do próprio alvo.
- **Cifrado em repouso** — todo artefato é cifrado com [`age`](https://age-encryption.org) para dois
  recipients (operacional + escrow); as chaves são envelopadas por uma KEK que vive fora do host.
- **Destinos S3-compatible** — AWS S3, Cloudflare R2, Backblaze B2, MinIO, SeaweedFS, Ceph RGW.
- **Agendamento com retenção GFS** — avô-pai-filho, ciente das cadeias full/incremental.
- **Atrito de restore de propósito** — restrito por papel, limitado por uma matriz de capacidade da
  engine, e sobrescrever um banco exige digitar o nome dele.
- **Interface web** — um painel construído em torno dos três estados, em inglês, português e espanhol.
- **Docker-first** — uma imagem única sem clients de banco, releases multi-arch assinadas com SBOM
  anexado.

## Início rápido

Você precisa de Docker com o plugin Compose. Nada é instalado nos seus servidores de banco.

```sh
git clone https://github.com/schrodump/schrodump.git
cd schrodump
cp .env.example .env

# Gere a key-encryption key e uma senha de banco, e coloque no .env.
# ATENÇÃO: perder a KEK é perder todos os backups — guarde uma cópia fora deste host.
openssl rand -base64 32   # -> SCHRODUMP_KEK
openssl rand -base64 24   # -> DB_PASSWORD

docker compose up -d
```

No primeiro boot o Schrodump imprime um **link de setup de uso único** para criar o primeiro
administrador:

```sh
docker compose logs schrodump | grep setupUrl
```

Abra, crie o admin e siga o fluxo guiado: destino → canary → alvo → teste → política. Passo a passo
completo em [docs/install.md](docs/install.md).

## Suportados

| Bancos | Object storage |
| --- | --- |
| PostgreSQL 13–18 | Qualquer endpoint **S3-compatible**: |
| MySQL 8 | AWS S3 · Cloudflare R2 · Backblaze B2 |
| MariaDB | MinIO · SeaweedFS · Ceph RGW |
| MongoDB | |

## Como funciona

O Schrodump é um monorepo (Node 22, TypeScript, pnpm) dividido por responsabilidade:

- **`packages/core`** — o domínio: estados, retenção, o manifesto. Funções puras, sem I/O.
- **`packages/engines`** — o que rodar por engine (descritores de dump/restore) e os probes de
  conexão.
- **`packages/runner`** — onde rodar: executores Docker efêmeros e gestão do scratch.
- **`packages/storage`** — o driver S3-compatible e seu canary put/get/delete.
- **`apps/server`** — Fastify + Prisma; compõe os quatro pacotes acima.
- **`apps/web`** — o painel em Next.js.

A imagem do servidor **não** contém `pg_dump`, `mysqldump` nem `mongodump` — rodar um dump
in-process prenderia todo alvo à versão de client que embarcasse, e alargaria a superfície de
ataque do único processo que detém toda credencial de banco. Os dumps rodam em executores
separados, pinados e efêmeros.

## Segurança

O Schrodump detém credenciais de todo banco que você aponta a ele, o que faz dele um alvo de alto
valor. O [modelo de ameaça](docs/security.md) é explícito quanto a isso:

- Credenciais são **write-only** e cifradas em envelope; a KEK pertence a um gerenciador de
  segredos, fora do host que ela protege.
- Artefatos são cifrados para dois recipients, então uma chave perdida não é um backup perdido.
- O socket do Docker **nunca** é montado direto — a stack padrão o filtra por um socket proxy,
  porque acesso ao socket é root no host.
- O **modo sealed** oferece separação real de custódia: a instância pode escrever artefatos que
  não consegue ler.
- Imagens publicadas são **assinadas** (cosign, keyless) e carregam um **SBOM**.

Achou uma vulnerabilidade? Veja [SECURITY.md](SECURITY.md). Por favor, não abra issue pública.

## Documentação

| Guia | |
| --- | --- |
| [Instalação & primeiro backup](docs/install.md) | De um host vazio a um backup verificado. |
| [Modelo de segurança](docs/security.md) | Modelo de ameaça, o socket do Docker, o scratch, a KEK, o modo sealed. |
| [Backups & restore](docs/backup-restore.md) | O que é um backup lógico, o que ele não cobre, por que o verify existe. |
| [LGPD / GDPR](docs/lgpd.md) | Retenção, criptografia por artefato, Object Lock vs. o direito de eliminação. |
| [Roadmap & escopo do v1](docs/roadmap.md) | O que ficou deliberadamente fora do v1, e por quê. |

## Status do projeto

O Schrodump está em desenvolvimento ativo rumo ao **v1**. O modelo de verificação, o agendamento, o
storage, a criptografia, a interface web e o pipeline completo de CI + release assinada estão
implementados e testados. Alguns caminhos de execução — execução de restore, entrega de notificações
— e backup físico/PITR estão no roadmap. [docs/roadmap.md](docs/roadmap.md) diz exatamente o que
está e o que não está no v1.

## Contribuindo

Contribuições são bem-vindas sob o Contributor License Agreement do projeto — veja
[CONTRIBUTING.md](CONTRIBUTING.md). Os commits seguem [Conventional Commits](https://www.conventionalcommits.org/),
e `pnpm typecheck`, `pnpm lint` e `pnpm test` precisam estar verdes.

## Licença

[AGPL-3.0-or-later](LICENSE) © ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA.

Rodar o Schrodump como serviço de rede significa que seus usuários têm direito ao código-fonte,
incluindo suas modificações. É uma escolha deliberada: uma ferramenta de backup deveria ser
auditável por quem confia seus dados a ela.

## Traduções

**O `README.md` (inglês) é a fonte de verdade.** [README.pt-BR.md](README.pt-BR.md) e
[README.es.md](README.es.md) são traduções mantidas em sincronia com ele: qualquer mudança no
`README.md` precisa atualizar os três no mesmo pull request, e a CI cobra isso. Corrigir só uma
tradução é permitido.
