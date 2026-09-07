// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { parseConnectionUrl, type ParseFailureReason } from "@/lib/connection-url";
import { z } from "zod";
import { useCreateTarget, useDiscoverDatabases, useUpdateTarget } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { ENGINE_KINDS, scopeProblemCode, type EngineKind } from "@/lib/domain";
import { formatBytes, formatServerVersion } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CredentialField } from "@/components/credential-field";
import { ErrorState } from "@/components/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages/en";
import type { DiscoverResult, Target } from "@/lib/types";

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

// What the scope question IS, per engine — because it is a different question each time. pg_dump
// copies exactly one database; mysqldump copies every one the probe found unless told otherwise;
// mongodump copies the instance or one database, and a replica set only ever the instance.
const scopeLegend: Record<EngineKind, MessageKey> = {
  postgres: "targets.scope.postgres",
  mysql: "targets.scope.mysql",
  mariadb: "targets.scope.mysql",
  mongodb: "targets.scope.mongodb",
};

// The subset a PATCH may carry. `engine` is absent because the server refuses it: every artifact
// already taken records the engine it was taken with, and the engine decides the dump/restore
// descriptors and the capability matrix.
const patchSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  tls: z.boolean(),
});

// scope comes from a Json column, so an array is what the API contract promises rather than what
// the runtime guarantees. Guard rather than assume: seeding this field wrong would silently rewrite
// which databases the target backs up.
function scopeDatabasesOf(target: Target | undefined): string[] {
  const databases = target?.scope?.databases;
  return Array.isArray(databases) ? databases.filter((d): d is string => typeof d === "string") : [];
}

// `target` present switches the form to edit mode. The engine stays visible but locked — what a
// target is is the first thing an operator reads off it.
export function TargetForm({ onDone, target }: { onDone: () => void; target?: Target }) {
  const t = useT();
  const create = useCreateTarget();
  const update = useUpdateTarget();
  const editing = target !== undefined;
  const pending = editing ? update.isPending : create.isPending;
  const failure = editing ? update.error : create.error;

  const [name, setName] = useState(target?.name ?? "");
  const [engine, setEngine] = useState<EngineKind>((target?.engine as EngineKind) ?? "postgres");
  const [host, setHost] = useState(target?.host ?? "");
  const [port, setPort] = useState(target?.port ?? 5432);
  const [username, setUsername] = useState(target?.username ?? "");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState(target?.tls ?? true);
  // The scope is a selection over what the server was found to hold — never typed. The free-text
  // field this replaced said "empty means all", which for postgres was false: empty meant the
  // maintenance database, and on a real deployment that backed up nothing while reporting success.
  const [selected, setSelected] = useState<string[]>(scopeDatabasesOf(target));
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const discover = useDiscoverDatabases();
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
    setSelected(value.databases);
    setUrlError(null);
    // Cleared on success: the URL holds the password in clear, and leaving it in state would keep
    // the secret in a second place for no benefit.
    setConnectionUrl("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (target !== undefined) {
      const parsed = patchSchema.safeParse({ name, host, port, username, tls });
      if (!parsed.success) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      // An empty password field means "leave the stored credential alone" — the only way to fix a
      // host when the UI can never read the secret back to re-submit it. "" would be a 400.
      update.mutate(
        {
          id: target.id,
          body: {
            ...parsed.data,
            scope: { databases: selected, schemas: [], collections: [] },
            ...(password.length > 0 ? { password } : {}),
          },
        },
        { onSuccess: onDone },
      );
      return;
    }

    const parsed = schema.safeParse({ name, engine, host, port, username, password, tls });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      { ...parsed.data, scope: { databases: selected, schemas: [], collections: [] } },
      { onSuccess: onDone },
    );
  }

  // Opens the connection exactly as the backup's own probe will — unscoped, through the engine's
  // maintenance database — so a discovery that works is also a backup that can probe. In edit mode
  // the password is write-only and starts empty, so re-discovering means typing it again; without
  // it the saved selection stands.
  const canDiscover =
    host.length > 0 && username.length > 0 && password.length > 0 && !discover.isPending;
  function runDiscovery() {
    discover.mutate(
      { engine, host, port, username, password, tls },
      {
        onSuccess: (result) => {
          setDiscovered(result);
          if (!result.ok) return;
          if (engine === "mongodb" && result.isReplicaSet === true) {
            // A replica set is dumped whole; whatever was picked before finding that out is moot.
            setSelected([]);
            return;
          }
          // Names that are not there — a typo carried in from a URL, a database since dropped —
          // are dropped rather than saved. The whole point is that the scope names what exists.
          const names = new Set(result.databases.map((d) => d.name));
          setSelected((current) => current.filter((name) => names.has(name)));
        },
      },
    );
  }
  function toggle(name: string) {
    if (engine === "mysql" || engine === "mariadb") {
      setSelected((current) =>
        current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
      );
      return;
    }
    setSelected([name]);
  }

  const problem = scopeProblemCode(engine, selected);
  const listed = discovered?.ok === true;
  const replicaSet = engine === "mongodb" && listed && discovered.isReplicaSet === true;
  const multi = engine === "mysql" || engine === "mariadb";
  // Save is refused for the same reasons the API refuses it, before the request is made.
  const submitDisabled = pending || problem !== null;

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
        <Select
          id="engine"
          value={engine}
          disabled={editing}
          onChange={(e) => setEngine(e.target.value as EngineKind)}
        >
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
        configured={editing}
        value={password}
        onChange={setPassword}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
        {t("targets.tls")}
      </label>
      <div className="space-y-3 sm:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={runDiscovery} disabled={!canDiscover}>
            {discover.isPending ? t("common.loading") : t("targets.discover")}
          </Button>
          {listed ? (
            <span className="text-sm text-[var(--color-state-verified)]">
              {t("targets.discover.found", {
                version:
                  discovered.serverVersionNum !== null
                    ? formatServerVersion(discovered.serverVersionNum)
                    : "?",
                count: String(discovered.databases.length),
              })}
            </span>
          ) : null}
          {discovered !== null && !discovered.ok ? (
            <span className="text-sm text-[var(--color-state-failed)]">
              {t("targets.probe.failed")}{" "}
              {t(`targets.probe.reason.${discovered.failure ?? "UNKNOWN"}`)}
            </span>
          ) : null}
          {discover.isError ? (
            <span className="text-sm text-[var(--color-state-failed)]">
              {t("targets.probe.failed")}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {editing && password.length === 0
            ? t("targets.scope.reenterPassword")
            : t("targets.discover.hint")}
        </p>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{t(scopeLegend[engine])}</legend>
          {replicaSet ? (
            <p className="text-sm text-muted-foreground">{t("targets.scope.replicaSet")}</p>
          ) : null}
          {engine === "mongodb" && listed && !replicaSet ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="scope"
                checked={selected.length === 0}
                onChange={() => setSelected([])}
              />
              {t("targets.scope.wholeInstance")}
            </label>
          ) : null}
          {listed && !replicaSet
            ? discovered.databases.map((db) => (
                <label key={db.name} className="flex items-center gap-2 text-sm">
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name="scope"
                    checked={selected.includes(db.name)}
                    onChange={() => toggle(db.name)}
                  />
                  <span>{db.name}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(db.sizeBytes)}</span>
                  {engine === "postgres" && db.name === "postgres" ? (
                    <span className="text-xs text-muted-foreground">
                      · {t("targets.scope.maintenance")}
                    </span>
                  ) : null}
                </label>
              ))
            : null}
          {!listed && selected.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("targets.scope.current", { databases: selected.join(", ") })}
            </p>
          ) : null}
          {engine === "postgres" && !listed && selected.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("targets.scope.discoverFirst")}</p>
          ) : null}
          {problem !== null && (listed || editing) ? (
            <p className="text-sm text-[var(--color-state-failed)]">
              {t(`targets.scope.problem.${problem}`)}
            </p>
          ) : null}
        </fieldset>
      </div>
      <div className="sm:col-span-2 space-y-2">
        {invalid ? (
          <p className="text-sm text-[var(--color-state-failed)]">{t("form.invalid")}</p>
        ) : null}
        {failure !== null ? <ErrorState message={failure.message} /> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitDisabled}>
            {pending ? t("common.loading") : editing ? t("common.save") : t("common.create")}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </form>
  );
}
