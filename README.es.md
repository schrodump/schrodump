<div align="center">

# Schrodump

**Copias de seguridad lógicas verificadas para PostgreSQL, MySQL/MariaDB y MongoDB.**

Una copia que una restauración no ha probado no es una copia — es una suposición.

[![Licencia: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-brightgreen.svg)](.nvmrc)
[![CI](https://github.com/schrodump/schrodump/actions/workflows/ci.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/ci.yml)
[![Seguridad](https://github.com/schrodump/schrodump/actions/workflows/security.yml/badge.svg)](https://github.com/schrodump/schrodump/actions/workflows/security.yml)

[English](README.md) · [Português](README.pt-BR.md) · **Español**

</div>

---

## Por qué Schrodump

Un trabajo de copia que termina con código `0` ha probado una sola cosa: un proceso se ejecutó sin
quejarse. **No** ha probado que el archivo en tu bucket contiene tus datos. Credenciales que
escriben pero no leen, un volcado truncado cuando cayó la conexión, una regla de retención que
borró la última copia buena — todos producen un trabajo en verde y un artefacto inservible, visible
solo a la hora de restaurar.

Por eso Schrodump se niega a llamar buena a una copia solo porque el trabajo tuvo éxito. Cada
artefacto está en **uno de tres estados**, y el color es contenido, no decoración:

| Estado | | Significado |
| --- | --- | --- |
| 🟢 **VERIFIED** | verde | Algo lo abrió y lo comprobó. Se restaura. |
| 🟡 **UNOBSERVED** | ámbar | Se escribió; nadie ha mirado dentro. Puede estar perfecto, o vacío. **Es el valor por defecto.** |
| 🔴 **FAILED** | rojo | Se comprobó y no sirve. |

No existe "OK". El panel encabeza con el número de copias **no observadas** — las preguntas
abiertas — no con el número de trabajos que tuvieron éxito. Esa inversión es el producto entero.

## Características

- **Restauración verificada** — checksum, o una restauración completa en una base desechable, por
  política.
- **Sin agente** — no se instala nada en el host de tu base de datos. Los volcados se ejecutan en
  contenedores efímeros construidos a partir de la versión mayor del propio destino.
- **Cifrado en reposo** — cada artefacto se cifra con [`age`](https://age-encryption.org) para dos
  destinatarios (operacional + escrow); las claves se envuelven con una KEK que vive fuera del host.
- **Destinos compatibles con S3** — AWS S3, Cloudflare R2, Backblaze B2, MinIO, SeaweedFS, Ceph RGW.
- **Programación con retención GFS** — abuelo-padre-hijo, consciente de las cadenas
  completa/incremental.
- **Fricción de restauración deliberada** — restringida por rol, acotada por una matriz de
  capacidad del motor, y sobrescribir una base exige escribir su nombre.
- **Interfaz web** — un panel construido en torno a los tres estados, en inglés y portugués.
- **Docker primero** — una única imagen sin clientes de base de datos, releases multiarquitectura
  firmadas con un SBOM adjunto.

## Inicio rápido

Necesitas Docker con el plugin Compose. No se instala nada en tus servidores de base de datos.

```sh
git clone https://github.com/schrodump/schrodump.git
cd schrodump
cp .env.example .env

# Genera la key-encryption key y una contraseña de base de datos, y ponlas en .env.
# ADVERTENCIA: perder la KEK es perder todas las copias — guarda una copia fuera de este host.
openssl rand -base64 32   # -> SCHRODUMP_KEK
openssl rand -base64 24   # -> DB_PASSWORD

docker compose up -d
```

En el primer arranque, Schrodump imprime un **enlace de configuración de un solo uso** para crear el
primer administrador:

```sh
docker compose logs schrodump | grep setupUrl
```

Ábrelo, crea el administrador y sigue el flujo guiado: destino → canary → destino a copiar → prueba
→ política. Guía completa en [docs/install.md](docs/install.md).

## Compatibilidad

| Bases de datos | Almacenamiento de objetos |
| --- | --- |
| PostgreSQL 13–18 | Cualquier endpoint **compatible con S3**: |
| MySQL 8 | AWS S3 · Cloudflare R2 · Backblaze B2 |
| MariaDB | MinIO · SeaweedFS · Ceph RGW |
| MongoDB | |

## Cómo funciona

Schrodump es un monorepo (Node 22, TypeScript, pnpm) dividido por responsabilidad:

- **`packages/core`** — el dominio: estados, retención, el manifiesto. Funciones puras, sin E/S.
- **`packages/engines`** — qué ejecutar por motor (descriptores de volcado/restauración) y las
  sondas de conexión.
- **`packages/runner`** — dónde ejecutarlo: ejecutores Docker efímeros y gestión del scratch.
- **`packages/storage`** — el driver compatible con S3 y su canary put/get/delete.
- **`apps/server`** — Fastify + Prisma; compone los cuatro paquetes anteriores.
- **`apps/web`** — el panel en Next.js.

La imagen del servidor **no** contiene `pg_dump`, `mysqldump` ni `mongodump` — ejecutar un volcado
en el propio proceso ataría cada destino a la versión de cliente que se incluyera, y ampliaría la
superficie de ataque del único proceso que guarda toda credencial de base de datos. Los volcados se
ejecutan en ejecutores separados, fijados por versión y efímeros.

## Seguridad

Schrodump guarda credenciales de cada base de datos a la que lo apuntas, lo que lo convierte en un
objetivo de alto valor. El [modelo de amenazas](docs/security.md) es explícito al respecto:

- Las credenciales son **de solo escritura** y están cifradas con envelope; la KEK pertenece a un
  gestor de secretos, fuera del host que protege.
- Los artefactos se cifran para dos destinatarios, así una clave perdida no es una copia perdida.
- El socket de Docker **nunca** se monta directamente — la stack por defecto lo filtra a través de
  un socket proxy, porque el acceso al socket es root en el host.
- El **modo sealed** ofrece separación real de custodia: la instancia puede escribir artefactos que
  no puede leer.
- Las imágenes publicadas están **firmadas** (cosign, keyless) y llevan un **SBOM**.

¿Encontraste una vulnerabilidad? Consulta [SECURITY.md](SECURITY.md). Por favor, no abras un issue
público.

## Documentación

| Guía | |
| --- | --- |
| [Instalación y primera copia](docs/install.md) | De un host vacío a una copia verificada. |
| [Modelo de seguridad](docs/security.md) | Modelo de amenazas, el socket de Docker, el scratch, la KEK, el modo sealed. |
| [Copias y restauración](docs/backup-restore.md) | Qué es una copia lógica, qué no cubre, por qué existe la verificación. |
| [LGPD / GDPR](docs/lgpd.md) | Retención, cifrado por artefacto, Object Lock frente al derecho de supresión. |
| [Hoja de ruta y alcance de v1](docs/roadmap.md) | Qué queda deliberadamente fuera de v1, y por qué. |

## Estado del proyecto

Schrodump está en desarrollo activo hacia su **v1**. El modelo de verificación, la programación, el
almacenamiento, el cifrado, la interfaz web y el pipeline completo de CI + release firmada están
implementados y probados. Algunos caminos de ejecución — la ejecución de restauraciones, el envío
de notificaciones — y las copias físicas/PITR están en la hoja de ruta.
[docs/roadmap.md](docs/roadmap.md) indica exactamente qué está y qué no está en v1.

## Contribuir

Las contribuciones son bienvenidas bajo el Contributor License Agreement del proyecto — consulta
[CONTRIBUTING.md](CONTRIBUTING.md). Los commits siguen [Conventional Commits](https://www.conventionalcommits.org/),
y `pnpm typecheck`, `pnpm lint` y `pnpm test` deben estar en verde.

## Licencia

[AGPL-3.0-or-later](LICENSE) © ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA.

Ejecutar Schrodump como servicio de red significa que sus usuarios tienen derecho a su código
fuente, incluidas tus modificaciones. Es una elección deliberada: una herramienta de copias de
seguridad debería ser auditable por quienes le confían sus datos.

## Traducciones

**El `README.md` (inglés) es la fuente de verdad.** [README.pt-BR.md](README.pt-BR.md) y
[README.es.md](README.es.md) son traducciones que se mantienen sincronizadas con él: cualquier
cambio en `README.md` debe actualizar los tres en el mismo pull request, y la CI lo exige. Corregir
solo una traducción está permitido.
