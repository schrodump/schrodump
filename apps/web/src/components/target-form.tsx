// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";
import { CredentialField } from "@/components/credential-field";
import { ErrorState } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { VerdictPanel } from "@/components/verdict-panel";
import { useCreateTarget, useDiscoverDatabases, useUpdateTarget } from "@/hooks/use-mutations";
import type { MessageKey } from "@/i18n/messages/en";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { parseConnectionUrl, type ParseFailureReason } from "@/lib/connection-url";
import { ENGINE_KINDS, scopeProblemCode, type EngineKind } from "@/lib/domain";
import { formatBytes } from "@/lib/format";
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

const engineLabel: Record<EngineKind, MessageKey> = {
  postgres: "engine.postgres",
  mysql: "engine.mysql",
  mariadb: "engine.mariadb",
  mongodb: "engine.mongodb",
};
const engineTool: Record<EngineKind, MessageKey> = {
  postgres: "targets.engine.tool.postgres",
  mysql: "targets.engine.tool.mysql",
  mariadb: "targets.engine.tool.mariadb",
  mongodb: "targets.engine.tool.mongodb",
};
const DEFAULT_PORT: Record<EngineKind, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017 };

// What the scope question IS, per engine — because it is a different question each time. pg_dump
// copies exactly one database; mysqldump copies every one the probe found unless told otherwise;
// mongodump copies the instance or one database, and a replica set only ever the instance.
type ScopeKind = "postgres" | "mysql" | "mongodb";
function scopeKindOf(engine: EngineKind): ScopeKind {
  return engine === "mariadb" ? "mysql" : engine;
}
const scopeRule: Record<ScopeKind, MessageKey> = {
  postgres: "targets.scope.rule.postgres",
  mysql: "targets.scope.rule.mysql",
  mongodb: "targets.scope.rule.mongodb",
};
const scopeIntro: Record<ScopeKind, MessageKey> = {
  postgres: "targets.scope.intro.postgres",
  mysql: "targets.scope.intro.mysql",
  mongodb: "targets.scope.intro.mongodb",
};

// scope comes from a Json column, so an array is what the API contract promises rather than what
// the runtime guarantees. Guard rather than assume: seeding this field wrong would silently rewrite
// which databases the target backs up.
function scopeDatabasesOf(target: Target | undefined): string[] {
  const databases = target?.scope?.databases;
  return Array.isArray(databases) ? databases.filter((d): d is string => typeof d === "string") : [];
}

function SectionLabel({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">{children}</span>
      {aside !== undefined ? (
        <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-accent">{aside}</span>
      ) : null}
    </div>
  );
}

function FieldLabel(props: { htmlFor: string; children: string }) {
  return (
    <Label htmlFor={props.htmlFor} className="block font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
      {props.children}
    </Label>
  );
}

// `target` present switches the form to edit mode. The engine stays visible but locked — what a
// target is is the first thing an operator reads off it.
export function TargetForm({ onDone, target }: { onDone: () => void; target?: Target }) {
  const t = useT();
  const create = useCreateTarget();
  const update = useUpdateTarget();
  const discover = useDiscoverDatabases();
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
  // Which connection the list came from. A list from one server offered against another is the
  // quiet way to save a scope that does not exist; the signature makes the mismatch visible.
  const [discoveredFor, setDiscoveredFor] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [connectionUrl, setConnectionUrl] = useState("");
  const [urlError, setUrlError] = useState<ParseFailureReason | null>(null);
  const [urlScheme, setUrlScheme] = useState("");
  const [urlNote, setUrlNote] = useState<string | null>(null);

  const signature = `${engine}|${host}|${port}|${username}`;
  const stale = discovered !== null && discoveredFor !== signature;
  const live = discovered !== null && !stale && discovered.ok ? discovered : null;
  const replicaSet = engine === "mongodb" && live !== null && live.isReplicaSet === true;
  const kind = scopeKindOf(engine);
  const multi = kind === "mysql";
  const hostPort = `${host.length > 0 ? host : "host"}:${port > 0 ? String(port) : "?"}`;
  const savedScope = editing && discovered === null ? scopeDatabasesOf(target) : [];

  // Any change to the connection invalidates a pick made against the old one: the signature marks
  // the list stale and the selection goes back to nothing (the saved scope, when editing, is what
  // the catalog holds and stands until a new discovery replaces it).
  function touchConnection() {
    if (discovered !== null && !stale) setSelected([]);
  }

  // The URL fills the form; it is never part of what gets submitted. On failure nothing is
  // touched — a form half-filled from a URL that did not parse is worse than an empty one.
  function fillFromUrl() {
    const result = parseConnectionUrl(connectionUrl);
    if (!result.ok) {
      setUrlError(result.reason);
      setUrlScheme(result.scheme ?? "");
      setUrlNote(null);
      return;
    }
    const value = result.value;
    if (!editing) setEngine(value.engine);
    setHost(value.host);
    setPort(value.port);
    if (value.username.length > 0) setUsername(value.username);
    if (value.password.length > 0) setPassword(value.password);
    if (value.tls !== null) setTls(value.tls);
    setSelected(value.databases);
    setUrlError(null);
    setUrlNote(
      value.databases.length > 0
        ? t("targets.url.filledPending", { database: value.databases.join(", ") })
        : t("targets.url.filled"),
    );
    // Cleared on success: the URL holds the password in clear, and leaving it in state would keep
    // the secret in a second place for no benefit.
    setConnectionUrl("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saveReason !== null) return;

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
  const credsReady = host.length > 0 && username.length > 0 && password.length > 0;
  const canDiscover = credsReady && !discover.isPending;
  function runDiscovery() {
    const forSignature = signature;
    discover.mutate(
      { engine, host, port, username, password, tls },
      {
        onSuccess: (result) => {
          setDiscovered(result);
          setDiscoveredFor(forSignature);
          // The URL's pending name is resolved either way now: kept if the server holds it,
          // dropped if not. The note that said "pending" would be stale from here on.
          setUrlNote(null);
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
  function toggle(dbName: string) {
    if (multi) {
      setSelected((current) =>
        current.includes(dbName) ? current.filter((n) => n !== dbName) : [...current, dbName],
      );
      return;
    }
    setSelected([dbName]);
  }

  // Save is refused for the same reasons the API refuses it, before the request is made — and the
  // button says which, in order of what the operator would fix first.
  const problem = scopeProblemCode(engine, selected);
  const saveReason: string | null =
    name.trim().length === 0
      ? t("targets.save.blocked.name")
      : host.trim().length === 0
        ? t("targets.save.blocked.host")
        : username.trim().length === 0
          ? t("targets.save.blocked.username")
          : !editing && password.length === 0
            ? t("targets.save.blocked.password")
            : kind === "postgres" && live !== null && selected.length !== 1
              ? t("targets.save.blocked.pickOne")
              : kind === "postgres" && live === null && !(editing && savedScope.length === 1)
                ? t("targets.save.blocked.discover")
                : problem === "mongodb"
                  ? t("targets.save.blocked.mongo")
                  : null;

  const discoverHint = discover.isPending
    ? t("targets.discover.running", { hostPort })
    : host.length === 0 || username.length === 0
      ? t("targets.discover.needHost")
      : password.length === 0
        ? t(editing ? "targets.discover.retypePassword" : "targets.discover.needPassword")
        : t("targets.discover.hintCreds");

  const staleOld = discoveredFor === null ? "" : describeSignature(discoveredFor);
  const scopeFoot =
    live === null
      ? null
      : kind === "postgres"
        ? selected.length === 0
          ? { text: t("targets.scope.foot.none"), caution: true }
          : selected[0] === "postgres"
            ? { text: t("targets.scope.foot.maintenance"), caution: true }
            : { text: t("targets.scope.foot.one", { name: selected[0] ?? "" }), caution: false }
        : kind === "mysql"
          ? selected.length === 0
            ? { text: t("targets.scope.foot.all"), caution: false }
            : {
                text: t("targets.scope.foot.multi", {
                  count: String(selected.length),
                  total: String(live.databases.length),
                  names: selected.join(", "),
                }),
                caution: false,
              }
          : selected.length === 0
            ? { text: t("targets.scope.foot.mongoAll"), caution: false }
            : { text: t("targets.scope.foot.mongoOne", { name: selected[0] ?? "" }), caution: false };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="max-w-2xl">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="rounded-sm border border-border-region bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
            {t(editing ? "targets.form.modeEdit" : "targets.form.modeCreate")}
          </span>
          <span className="font-mono text-[10.5px] text-subtle-foreground">
            {editing ? t("targets.form.editNote", { name: target.name }) : t("targets.form.createNote")}
          </span>
        </div>
        <h2 className="mt-2 text-xl font-semibold">
          {t(editing ? "targets.form.editTitle" : "targets.form.createTitle")}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground text-pretty">{t("targets.form.intro")}</p>
      </div>

      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
        <div className="space-y-5">
          <Panel tone="section" className="space-y-3">
            <SectionLabel aside={t("targets.url.clientSide")}>{t("targets.url.title")}</SectionLabel>
            <p className="text-[12.5px] text-muted-foreground text-pretty">{t("targets.url.note")}</p>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="connection-url">{t("targets.url")}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="connection-url"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="postgresql://user:password@host:5432/db"
                  className="font-mono"
                  value={connectionUrl}
                  onChange={(e) => {
                    setConnectionUrl(e.target.value);
                    setUrlError(null);
                  }}
                />
                <Button type="button" variant="quiet" onClick={fillFromUrl}>
                  {t("targets.url.fill")}
                </Button>
              </div>
            </div>
            {urlError !== null ? (
              <Panel tone="error" role="alert" className="p-3">
                <div className="text-[12.5px] font-medium text-destructive-text">{t("targets.url.nothingFilled")}</div>
                <p className="mt-1 text-[12.5px]">{t(`targets.url.error.${urlError}`, { scheme: urlScheme })}</p>
              </Panel>
            ) : null}
            {urlNote !== null ? <p className="font-mono text-[11.5px] text-state-verified">{urlNote}</p> : null}
          </Panel>

          <Panel tone="section" className="space-y-4">
            <SectionLabel>{t("targets.section.target")}</SectionLabel>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="name">{t("targets.name")}</FieldLabel>
              <Input id="name" value={name} placeholder="prod-orders" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <FieldLabel htmlFor="engine">{t("targets.engine")}</FieldLabel>
                {editing ? (
                  <span className="font-mono text-[10.5px] text-subtle-foreground">{t("targets.engine.fixed")}</span>
                ) : null}
              </div>
              <Select
                id="engine"
                value={engine}
                disabled={editing}
                onChange={(e) => {
                  const next = e.target.value as EngineKind;
                  // The port follows the engine while it is still the previous engine's default —
                  // a port the operator typed is theirs and stays.
                  if (port === DEFAULT_PORT[engine]) setPort(DEFAULT_PORT[next]);
                  setEngine(next);
                  touchConnection();
                }}
              >
                {ENGINE_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(engineLabel[option])}
                  </option>
                ))}
              </Select>
              <p className="font-mono text-[11px] text-subtle-foreground">{t(engineTool[engine])}</p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="host">{t("targets.host")}</FieldLabel>
                <Input
                  id="host"
                  value={host}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(e) => {
                    setHost(e.target.value);
                    touchConnection();
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel htmlFor="port">{t("targets.port")}</FieldLabel>
                <Input
                  id="port"
                  type="number"
                  value={port}
                  className="font-mono"
                  onChange={(e) => {
                    setPort(Number(e.target.value));
                    touchConnection();
                  }}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="username">{t("targets.username")}</FieldLabel>
              <Input
                id="username"
                value={username}
                spellCheck={false}
                className="font-mono"
                onChange={(e) => {
                  setUsername(e.target.value);
                  touchConnection();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <CredentialField
                id="password"
                label={t("targets.password")}
                configured={editing}
                value={password}
                onChange={setPassword}
              />
              <p className="text-[12px] text-muted-foreground text-pretty">
                {t(editing ? "targets.password.helpConfigured" : "targets.password.help")}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
              {t("targets.tls")}
            </label>
          </Panel>
        </div>

        <Panel tone="section" className="space-y-4 self-start">
          <SectionLabel aside={t(scopeRule[kind])}>{t("targets.scope.title")}</SectionLabel>
          <p className="text-[12.5px] text-muted-foreground text-pretty">{t(scopeIntro[kind])}</p>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="accent" onClick={runDiscovery} disabled={!canDiscover}>
              {discover.isPending ? t("common.loading") : live !== null ? t("targets.discover.again") : t("targets.discover")}
            </Button>
            <span className={cn("font-mono text-[10.5px]", credsReady || discover.isPending ? "text-subtle-foreground" : "text-caution")}>
              {discoverHint}
            </span>
          </div>

          {discovered !== null && !stale ? (
            <VerdictPanel result={discovered} hostPort={hostPort} user={username} tls={tls} />
          ) : null}
          {discover.isError ? <ErrorState message={discover.error.message} /> : null}

          {stale ? (
            <Panel tone="warning" className="p-3.5">
              <div className="text-[12.5px] font-medium text-caution">{t("targets.scope.stale.title")}</div>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {t("targets.scope.stale.detail", { old: staleOld, new: describeSignature(signature) })}
              </p>
            </Panel>
          ) : null}

          {replicaSet && live !== null ? (
            <Panel tone="lock" className="p-3.5">
              <div className="text-[12.5px] font-medium">{t("targets.scope.lock.title")}</div>
              <p className="mt-1 text-[12.5px] text-muted-foreground">{t("targets.scope.lock.reason")}</p>
              <ul className="mt-3 space-y-1 font-mono text-[12px]">
                {live.databases.map((db) => (
                  <li key={db.name} className="flex items-baseline justify-between gap-3">
                    <span>{db.name}</span>
                    <span className="text-muted-foreground">{formatBytes(db.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
                {t("targets.scope.found", { count: String(live.databases.length) })}
              </p>
            </Panel>
          ) : null}

          {live !== null && !replicaSet ? (
            <fieldset className="space-y-2">
              <legend className="flex w-full items-baseline justify-between gap-3">
                <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
                  {t(multi ? "targets.scope.pickMany" : "targets.scope.pickOne")}
                </span>
                <span className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
                  {t("targets.scope.found", { count: String(live.databases.length) })}
                </span>
              </legend>
              {engine === "mongodb" ? (
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-sm",
                    selected.length === 0 ? "border-accent-border bg-accent-soft" : "border-border",
                  )}
                >
                  <input type="radio" name="scope" checked={selected.length === 0} onChange={() => setSelected([])} />
                  <span>{t("targets.scope.wholeInstance")}</span>
                </label>
              ) : null}
              {live.databases.map((db) => {
                const maintenance = engine === "postgres" && db.name === "postgres";
                const picked = selected.includes(db.name);
                return (
                  <label
                    key={db.name}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-sm",
                      picked ? "border-accent-border bg-accent-soft" : "border-border hover:border-border-region",
                    )}
                  >
                    <input type={multi ? "checkbox" : "radio"} name="scope" checked={picked} onChange={() => toggle(db.name)} />
                    <span className="font-mono text-[12.5px]">{db.name}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">{formatBytes(db.sizeBytes)}</span>
                    {maintenance ? (
                      <span className="font-mono text-[11px] text-caution">· {t("targets.scope.maintenance")}</span>
                    ) : null}
                  </label>
                );
              })}
              {scopeFoot !== null ? (
                <p className={cn("text-[12.5px] text-pretty", scopeFoot.caution ? "text-caution" : "text-muted-foreground")}>
                  {scopeFoot.text}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {discovered === null && savedScope.length > 0 ? (
            <Panel tone="info" className="p-3.5">
              <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground">
                {t("targets.scope.saved")}
              </div>
              <p className="mt-2 font-mono text-[12.5px]">
                {t("targets.scope.current", { databases: savedScope.join(", ") })}
              </p>
              <p className="mt-2 text-[12px] text-muted-foreground text-pretty">{t("targets.scope.savedNote")}</p>
            </Panel>
          ) : null}

          {discovered === null && savedScope.length === 0 ? (
            <Panel tone="empty" className="p-4 text-left">
              <p className="text-[12.5px] text-muted-foreground text-pretty">{t("targets.scope.discoverFirst")}</p>
              {selected.length > 0 ? (
                <p className="mt-2 font-mono text-[12px]">{t("targets.scope.current", { databases: selected.join(", ") })}</p>
              ) : null}
            </Panel>
          ) : null}
        </Panel>
      </div>

      {invalid ? <p className="text-sm text-destructive-text">{t("form.invalid")}</p> : null}
      {failure !== null ? <ErrorState message={failure.message} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {saveReason === null ? (
          <span className="font-mono text-[10.5px] tracking-[0.04em] uppercase text-subtle-foreground">
            {t("targets.save.note")}
          </span>
        ) : (
          <span />
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="quiet" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending} disabledReason={pending ? null : saveReason}>
            {pending ? t("common.loading") : t(editing ? "targets.save.edit" : "targets.save.create")}
          </Button>
        </div>
      </div>
    </form>
  );
}

// "postgres db.internal:5432 as ana" — the connection a list came from, in words.
function describeSignature(signature: string): string {
  const [engine, host, port, user] = signature.split("|");
  return `${engine ?? ""} ${host ?? ""}:${port ?? ""} as ${user !== undefined && user.length > 0 ? user : "—"}`;
}
