// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useState } from "react";
import { useT } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Write-only credential input. It has no way to receive a value from the server: `value` is the
// form's local state (starts empty) and `configured` only signals that a credential already
// exists on the server. When configured, we show "Configured" + Replace; the input never carries
// the stored secret.
export function CredentialField({
  id,
  label,
  configured,
  value,
  onChange,
}: {
  id: string;
  label: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const [replacing, setReplacing] = useState(!configured);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {configured && !replacing ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("common.configured")}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            {t("common.replace")}
          </Button>
        </div>
      ) : (
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={value}
          placeholder={configured ? t("credential.replacePlaceholder") : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
