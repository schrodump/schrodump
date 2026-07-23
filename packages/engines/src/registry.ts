// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import type { EngineKind } from "@schrodump/core/types";
import { mariadbAdapter, mysqlAdapter } from "./adapters/mysql.js";
import { mongodbAdapter } from "./adapters/mongodb.js";
import { postgresAdapter } from "./adapters/postgres.js";
import type { EngineAdapter } from "./descriptor.js";

// The single dispatch point per engine. Adding an engine is ONE entry here — never a new
// `if (engine === ...)` scattered through the code.
const ADAPTERS: Readonly<Record<EngineKind, EngineAdapter>> = {
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
  mariadb: mariadbAdapter,
  mongodb: mongodbAdapter,
};

export function resolveAdapter(kind: EngineKind): EngineAdapter {
  return ADAPTERS[kind];
}
