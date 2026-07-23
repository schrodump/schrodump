// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useCreateTarget } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { ENGINE_KINDS, type EngineKind } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { CredentialField } from "@/components/credential-field";
import { ErrorState } from "@/components/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages/en";

const schema = z.object({
  name: z.string().min(1),
  engine: z.enum(ENGINE_KINDS),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean(),
});

const engineLabel: Record<EngineKind, MessageKey> = {
  postgres: "engine.postgres",
  mysql: "engine.mysql",
  mariadb: "engine.mariadb",
  mongodb: "engine.mongodb",
};

export function TargetForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const create = useCreateTarget();
  const [name, setName] = useState("");
  const [engine, setEngine] = useState<EngineKind>("postgres");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(5432);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState(true);
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse({ name, engine, host, port, username, password, tls });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      { ...parsed.data, scope: { databases: [], schemas: [], collections: [] } },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="name">{t("targets.name")}</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="engine">{t("targets.engine")}</Label>
        <Select id="engine" value={engine} onChange={(e) => setEngine(e.target.value as EngineKind)}>
          {ENGINE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(engineLabel[kind])}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="host">{t("targets.host")}</Label>
        <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="port">{t("targets.port")}</Label>
        <Input
          id="port"
          type="number"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="username">{t("targets.username")}</Label>
        <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <CredentialField
        id="password"
        label={t("targets.password")}
        configured={false}
        value={password}
        onChange={setPassword}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
        {t("targets.tls")}
      </label>
      <div className="sm:col-span-2 space-y-2">
        {invalid ? <p className="text-sm text-[var(--color-state-failed)]">{t("form.invalid")}</p> : null}
        {create.isError ? <ErrorState message={create.error.message} /> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t("common.loading") : t("common.create")}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </form>
  );
}
