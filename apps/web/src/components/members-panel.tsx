// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMembers } from "@/hooks/use-resources";
import { useCreateMember, useDeleteMember, useUpdateMemberRole } from "@/hooks/use-mutations";
import { useT } from "@/i18n/provider";
import { ROLES, type Role } from "@/lib/domain";
import type { CreatedMember } from "@/lib/types";

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
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    create.mutate(
      { email, name, role },
      {
        onSuccess: (created) => {
          setMinted(created);
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
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.members")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("members.forbidden")}</p>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.members")}</CardTitle>
        <CardDescription>{t("settings.members.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {(query.data ?? []).map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{member.email}</span>
              <select
                aria-label={t("members.roleOf", { email: member.email })}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                value={member.role}
                onChange={(event) =>
                  updateRole.mutate(
                    { userId: member.userId, role: event.target.value },
                    { onError: (err: Error) => setError(err.message) },
                  )
                }
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {t(`role.${option}`)}
                  </option>
                ))}
              </select>
              {member.mustChangePassword ? (
                <span className="rounded-full bg-[var(--color-state-unobserved-bg)] px-2 py-0.5 text-xs text-[var(--color-state-unobserved)]">
                  {t("members.pendingRotation")}
                </span>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  remove.mutate(member.userId, { onError: (err: Error) => setError(err.message) })
                }
              >
                {t("members.remove")}
              </Button>
            </li>
          ))}
        </ul>

        {minted !== null ? (
          <div className="rounded-md border border-[var(--color-state-failed)] p-3">
            <p className="text-sm font-medium">
              {t("members.minted", { email: minted.member.email })}
            </p>
            <p className="mt-1 font-mono text-sm break-all">{minted.temporaryPassword}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t("members.minted.warning")}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setMinted(null)}>
              {t("members.minted.done")}
            </Button>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="member-email">{t("members.email")}</Label>
            <Input
              id="member-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-name">{t("members.name")}</Label>
            <Input
              id="member-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-role">{t("members.role")}</Label>
            <select
              id="member-role"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {t(`role.${option}`)}
                </option>
              ))}
            </select>
          </div>
          {error !== null ? (
            <p className="text-sm text-[var(--color-state-failed)]">{error}</p>
          ) : null}
          <Button type="submit" disabled={create.isPending || email.length === 0}>
            {t("members.add")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
