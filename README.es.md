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

> **Beta: pre-1.0, un solo mantenedor.** Diecinueve release candidates, ninguna versión estable
> todavía.
>
> **Lo que está probado.** Cada pull request levanta el `compose.yaml` que publicamos y le hace
> pasar veintidós pasos: los cuatro motores en ambos modos de ejecución, cada uno verificado con una
> restauración real, tres de ellos restaurados sobre datos vivos, un catálogo reconstruido solo
> desde el bucket, una rotación de clave con el artefacto anterior aún legible, la retención
> borrando de verdad, una notificación firmada y un correo entregados.
>
> **Lo que no.** No hay nada etiquetado como estable, así que todavía no se promete nada sobre
> actualizar de una versión a la siguiente, y v1 sale con aristas conocidas — todas escritas en
> [docs/roadmap.md](docs/roadmap.md#known-limitations-shipping-in-v1). Lee esa lista antes de
> depender de esto.

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
| 🟢 **VERIFIED** | verde | Algo lo abrió y lo comprobó. Por defecto, eso significa que se restauró en una base desechable; un verde solo por checksum lo dice junto a la insignia. |
| 🟡 **UNOBSERVED** | ámbar | Se escribió; nadie ha mirado dentro. Puede estar perfecto, o vacío. **Es el valor por defecto.** |
| 🔴 **FAILED** | rojo | Se comprobó y no sirve. |

No existe "OK". El panel encabeza con el número de copias **no observadas** — las preguntas
abiertas — no con el número de trabajos que tuvieron éxito. Esa inversión es el producto entero.

## Características

- **Restauración verificada** — por defecto cada copia se restaura en una base desechable y se
  comprueba; un checksum, más barato, es una elección por política, y la insignia dice de cuál vino un verde.
- **Sin agente** — no se instala nada en el host de tu base de datos. Los volcados se ejecutan en
  contenedores efímeros construidos a partir de la versión mayor del propio destino.
- **Cifrado en reposo** — cada artefacto se cifra con [`age`](https://age-encryption.org) para dos
  destinatarios (operacional + escrow); esas dos claves se envuelven con una KEK que pertenece a un
  gestor de secretos y se inyecta al arrancar. El inicio rápido de abajo la escribe en el `.env` del
  host para que puedas empezar, y sacarla de ahí es lo primero que hay que hacer.
- **Destinos compatibles con S3** — AWS S3, Cloudflare R2, Backblaze B2, MinIO, SeaweedFS, Ceph RGW.
- **Programación con retención GFS** — abuelo-padre-hijo por recuento y por ventana de calendario,
  que solo se ejecuta cuando ha entrado una copia nueva de la misma política, y nunca borra la copia
  verificada más reciente de una política.
- **Fricción de restauración deliberada** — restringida por rol, acotada por una matriz de
  capacidad del motor, y sobrescribir una base exige escribir su nombre.
- **Interfaz web** — un panel construido en torno a los tres estados, en inglés, portugués y español.
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
openssl rand -hex 24      # -> DB_PASSWORD

docker compose up -d
```

`.env.example` ejecuta la versión más reciente (`SCHRODUMP_IMAGE=…:next`); en producción, fija ahí una
versión exacta. El directorio de scratch lo crea y se lo entrega al usuario del servidor un servicio
`scratch-init` de una sola ejecución, así que no hay nada que `mkdir` ni `chown` antes.

En el primer arranque, Schrodump imprime un **enlace de configuración de un solo uso** para crear el
primer administrador:

```sh
docker compose logs schrodump | grep setupUrl
```

Ábrelo exactamente en la dirección que imprime —el inicio de sesión se rechaza desde cualquier
origen distinto de `SCHRODUMP_URL`—, crea el administrador y sigue el flujo guiado: claves de cifrado
→ destino → canary → base de datos a copiar → prueba → política. Guía completa en
[docs/install.md](docs/install.md).

> **El puerto se publica solo en loopback.** Llegar a Schrodump desde otra máquina exige un proxy
> inverso que termine TLS delante: la cookie de sesión lleva toda la autoridad del operador, y HTTP
> plano se la entrega a cualquiera que esté en el camino.
> [docs/install.md](docs/install.md#put-it-behind-tls-this-is-not-optional) tiene las
> configuraciones de Caddy y nginx, y el único ajuste que no puedes olvidar junto a ellas.

## Compatibilidad

| Bases de datos | Almacenamiento de objetos |
| --- | --- |
| PostgreSQL 13–18 | Cualquier endpoint **compatible con S3**: |
| MySQL 8 | AWS S3 · Cloudflare R2 · Backblaze B2 |
| MariaDB | MinIO · SeaweedFS · Ceph RGW |
| MongoDB | |

## Cómo se compara — y cuándo no usar Schrodump

| En lugar de Schrodump | Qué es | Por qué lo elegirías |
| --- | --- | --- |
| **pgBackRest**, **Barman**, **WAL-G** | Copia física de PostgreSQL con archivado continuo de WAL y recuperación a un punto en el tiempo (PITR) | Necesitas un punto de recuperación medido en segundos, o tienes un clúster lo bastante grande como para que volcar y recargar no sea una restauración plausible. Son la respuesta madura a ese problema, y Schrodump no compite con ellas. |
| **restic**, **Backrest** | Copia de archivos, cifrada y deduplicada, de lo que haya en un disco | Quieres una sola herramienta para el host entero, no solo para sus bases de datos. Ojo: copiar un directorio de datos en uso no es por sí solo una copia consistente de base de datos — hace falta un snapshot del sistema de archivos o el motor parado. |
| **postgresus**, **databasus** | `pg_dump` programado, autoalojado, con panel y notificaciones | Lo más parecido en forma a Schrodump, y más simple. Si un trabajo que terminó en `0` es la garantía que buscas, te la dan con menos piezas. |
| **`pg_dump` + cron** | La línea de base de la que parte todo el mundo | Nada que desplegar, nada nuevo en lo que confiar. Es exactamente lo que Schrodump automatiza — más la parte en la que algo abre el archivo después. |
| **Copias gestionadas** (RDS, Cloud SQL, Atlas y compañía) | Snapshots del proveedor, normalmente con PITR | Son buenas, ya están pagadas y casi con seguridad deberías dejarlas activadas. También viven dentro de la cuenta que puede borrarlas, rara vez se mueven entre proveedores y nada en ellas te pide que ensayes la restauración. |

**Dónde pierde Schrodump.** **No hace PITR ni copias físicas**, y eso es estructural, no algo a
medio terminar: llega a tu base de datos por el protocolo de cliente, desde un contenedor que está
en otro sitio — eso es lo que lo hace sin agente y también la razón por la que nunca podrá enganchar
un `archive_command` ni leer un directorio de datos. Es decir: **tu punto de recuperación es el
último volcado, y tu tiempo de recuperación es lo que tarde una restauración** — mide los dos, y si
cualquiera de esos números es inaceptable, necesitas la primera fila de esa tabla y no esta
herramienta. Volcar y recargar además escala peor que una copia a nivel de archivo: en una base
grande, la restauración es la mitad cara. [docs/roadmap.md](docs/roadmap.md) recoge el razonamiento
y lo que tendría que cambiar.

**Lo que sí hace y las demás no.** Se niega a dar por buena una copia porque un proceso terminó en
`0`. Varias de las herramientas de arriba comprueban integridad — `restic check`,
`pgbackrest verify` — y eso es una comprobación real sobre los bytes; lo que Schrodump hace por
defecto es más fuerte y más estrecho: restaurar el artefacto en una base desechable de la versión
correcta, confirmar que abre y, mientras nada lo haya hecho, mostrarlo como pregunta abierta en
lugar de como éxito. Usar ambos es la configuración sensata — copias físicas para el punto de
recuperación, Schrodump para la evidencia de que un volcado, que además puedes llevarte, restaura.

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
almacenamiento, el cifrado, la retención GFS, la ejecución de restauraciones, el envío de
notificaciones (webhook y SMTP), la autocopia del propio catálogo, la interfaz web y el pipeline
completo de CI + release firmada están implementados y probados. La restauración cubre artefactos
single-stream y staged (directorio), y tiene alcance donde el motor ofrece un mecanismo para ello:
PostgreSQL hasta esquema o tabla, MongoDB hasta base de datos o colección. Un replica set de
MongoDB se vuelca junto con su oplog, y una restauración full-cluster lo reaplica, de modo que todas
las colecciones quedan en un mismo instante. Las copias físicas/PITR están en la hoja de ruta.
[docs/roadmap.md](docs/roadmap.md) indica exactamente qué está y qué no está en v1, y el
[CHANGELOG.md](CHANGELOG.md) enumera todas las release candidates publicadas hasta ahora y qué
cambió cada una.

## Contribuir

Las contribuciones son bienvenidas bajo el [Developer Certificate of Origin](https://developercertificate.org/) — firma tus commits con `git commit -s`. Consulta
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
