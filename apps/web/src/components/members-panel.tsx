// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { AcknowledgeCheckbox } from "@/components/ui/acknowledge-checkbox";
import { Button } from "@/components/ui/button";
import { FieldLabel, SectionLabel } from "@/components/ui/form-bits";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { AdminOnly, SettingsPanel } from "@/components/settings-panel";
import { useCreateMember, useDeleteMember, useUpdateMemberRole } from "@/hooks/use-mutations";
import { useMembers } from "@/hooks/use-resources";
import { useT } from "@/i18n/provider";
import { cn } from "@/lib/cn";
import { ROLES, type Role } from "@/lib/domain";
import type { CreatedMember } from "@/lib/types";

const ROW_GRID = "grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)_auto]";

export function MembersPanel() {
  const t = useT();
  const query = useMembers();
  const create = useCreateMember();
  const updateRole = useUpdateMemberRole();
  const remove = useDeleteMember();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  // Held in component state because there is no second GET that returns it. The server mints it,
  // answers with it once, and never stores it in readable form again.
  const [minted, setMinted] = useState<CreatedMember | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (email.trim().length === 0) return;
    setError(null);
    create.mutate(
      { email, name, role },
      {
        onSuccess: (created) => {
          setMinted(created);
          setCopied(false);
          setEmail("");
          setName("");
        },
        onError: (err: Error) => setError(err.message),
      },
    );
  }

  // 403 for a non-admin. Says so, rather than rendering an empty list that reads as "this
  // organization has no members" — which would be false and alarming in equal measure.
  if (query.isError)
    return (
      <SettingsPanel title={t("settings.members")}>
        <AdminOnly>{t("members.forbidden")}</AdminOnly>
      </SettingsPanel>
    );

  return (
    <SettingsPanel title={t("settings.members")} description={t("settings.members.description")}>
      <div className="space-y-5">
        {minted !== null ? (
          <Panel tone="danger" className="space-y-3 p-4">
            <div className="font-mono text-[10px] tracking-[0.13em] uppercase text-destructive-text">
              {t("members.minted", { email: minted.member.email })}
            </div>
            <pre className="overflow-x-auto rounded-control border border-destructive-border bg-background p-3 font-mono text-[13px] break-all whitespace-pre-wrap">
              {minted.temporaryPassword}
            </pre>
            <p className="text-[12.5px] text-pretty">{t("members.minted.warning")}</p>
            <AcknowledgeCheckbox checked={copied} onChange={setCopied}>
              {t("members.minted.done")}
            </AcknowledgeCheckbox>
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="quiet" onClick={() => setMinted(null)} disabledReason={copied ? null : t("members.minted.blocked")}>
                {t("members.minted.dismiss")}
              </Button>
            </div>
          </Panel>
        ) : null}

        <div>
          <div className={cn("grid gap-x-3 border-b border-border px-1 pb-1.5 font-mono text-[10px] tracking-[0.13em] uppercase text-subtle-foreground", ROW_GRID)}>
            <span>{t("members.col.email")}</span>
            <span>{t("members.col.role")}</span>
            <span>{t("members.col.status")}</span>
            <span />
          </div>
          <ul>
            {(query.data ?? []).map((member) => (
              <li key={member.userId} className={cn("grid items-center gap-x-3 border-b border-border px-1 py-2", ROW_GRID)}>
                <span className="truncate font-mono text-[12.5px]">{member.email}</span>
                <Select
                  aria-label={t("members.roleOf", { email: member.email })}
                  className="h-8 text-[12.5px]"
                  value={member.role}
                  onChange={(event) =>
                    updateRole.mutate({ userId: member.userId, role: event.target.value }, { onError: (err: Error) => setError(err.message) })
                  }
                >
                  {ROLES.map((option) => (
                    <option key={option} value={option}>
                      {t(`role.${option}`)}
                    </option>
                  ))}
                </Select>
                <span className="min-w-0 text-[12px] text-caution">
                  {member.mustChangePassword ? t("members.pendingRotation") : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove.mutate(member.userId, { onError: (err: Error) => setError(err.message) })}
                >
                  {t("members.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <SectionLabel>{t("members.add.title")}</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="member-email">{t("members.email")}</FieldLabel>
              <Input id="member-email" type="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="member-name">{t("members.name")}</FieldLabel>
              <Input id="member-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="member-role">{t("members.role")}</FieldLabel>
              <Select id="member-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {t(`role.${option}`)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {error !== null ? <p className="text-[12.5px] text-destructive-text">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={create.isPending} disabledReason={create.isPending || email.length > 0 ? null : t("members.blocked.email")}>
              {create.isPending ? t("common.loading") : t("members.add")}
            </Button>
          </div>
        </form>
      </div>
    </SettingsPanel>
  );
}
