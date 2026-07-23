// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { parseConnectionUrl, type ParseFailureReason } from "@/lib/connection-url";
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
  const [databases, setDatabases] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [connectionUrl, setConnectionUrl] = useState("");
  const [urlError, setUrlError] = useState<ParseFailureReason | null>(null);
  const [urlScheme, setUrlScheme] = useState("");

  // The URL fills the form; it is never part of what gets submitted. On failure nothing is
  // touched — a form half-filled from a URL that did not parse is worse than an empty one.
  function fillFromUrl() {
    const result = parseConnectionUrl(connectionUrl);
    if (!result.ok) {
      setUrlError(result.reason);
      setUrlScheme(result.scheme ?? "");
      return;
    }
    const value = result.value;
    setEngine(value.engine);
    setHost(value.host);
    setPort(value.port);
    if (value.username.length > 0) setUsername(value.username);
    if (value.password.length > 0) setPassword(value.password);
    if (value.tls !== null) setTls(value.tls);
    setDatabases(value.databases.join(", "));
    setUrlError(null);
    // Cleared on success: the URL holds the password in clear, and leaving it in state would keep
    // the secret in a second place for no benefit.
    setConnectionUrl("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse({ name, engine, host, port, username, password, tls });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const names = databases
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    create.mutate(
      { ...parsed.data, scope: { databases: names, schemas: [], collections: [] } },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="connection-url">{t("targets.url")}</Label>
        <div className="flex gap-2">
          <Input
            id="connection-url"
            type="password"
            autoComplete="off"
            value={connectionUrl}
            onChange={(e) => setConnectionUrl(e.target.value)}
          />
          <Button type="button" variant="outline" onClick={fillFromUrl}>
            {t("targets.url.fill")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("targets.url.hint")}</p>
        {urlError !== null ? (
          <p className="text-sm text-[var(--color-state-failed)]">
            {t(`targets.url.error.${urlError}`, { scheme: urlScheme })}
          </p>
        ) : null}
      </div>

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
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="databases">{t("targets.databases")}</Label>
        <Input id="databases" value={databases} onChange={(e) => setDatabases(e.target.value)} />
      </div>
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
