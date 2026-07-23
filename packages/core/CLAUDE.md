# @schrodump/core

Pacote base do Schrodump. Prevalece sobre o `CLAUDE.md` da raiz dentro deste diretório.

## Invariantes (não negociáveis)

- **Zero I/O, zero rede, zero Docker, zero Prisma, zero filesystem.** Funções puras.
- **Única dependência de runtime: `zod`.** Se parecer necessário importar outro pacote do
  workspace, **pare e reporte** — a abstração está errada.
- **`if (engine === ...)` só existe em `src/capabilities.ts`.** É o único lugar do pacote
  que conhece diferença entre engines; o resto consome `resolveCapabilities`.
- **Sem barrel `index.ts`.** A API pública é exposta por subpath no `exports` do
  `package.json`; exporte explicitamente só o que é público.
- O manifesto **nunca** carrega credencial, connection string, material de chave ou
  amostra de dado. `keyIds` são fingerprints.

## SPDX

Todo arquivo-fonte começa com:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA
```
