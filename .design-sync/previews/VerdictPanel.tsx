// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { VerdictPanel } from "@schrodump/web";

const databases = [
  { name: "ipog_finance", sizeBytes: 9_446_000_000 },
  { name: "ipog_nexus", sizeBytes: 1_288_000_000 },
  { name: "postgres", sizeBytes: 8_400_000 },
];

export function Connected() {
  return (
    <div className="max-w-xl">
      <VerdictPanel
        result={{ ok: true, serverVersionNum: 160_002, failure: null, driverCode: null, databases, isReplicaSet: null }}
        hostPort="db.ipog.internal:5432"
        user="schrodump_ro"
        tls
      />
    </div>
  );
}

export function Refused() {
  return (
    <div className="max-w-xl">
      <VerdictPanel
        result={{ ok: false, serverVersionNum: null, failure: "INSUFFICIENT_PRIVILEGES", driverCode: null, databases: [], isReplicaSet: null }}
        hostPort="db.ipog.internal:5432"
        user="schrodump_ro"
        tls
      />
    </div>
  );
}

export function UnknownWithDriverCode() {
  return (
    <div className="max-w-xl">
      <VerdictPanel
        result={{ ok: false, serverVersionNum: null, failure: "UNKNOWN", driverCode: "28P01", databases: [], isReplicaSet: null }}
        hostPort="db.ipog.internal:5432"
        user="schrodump_ro"
        tls={false}
      />
    </div>
  );
}
