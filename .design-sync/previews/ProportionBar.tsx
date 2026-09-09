// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { ProportionBar } from "@schrodump/web";

// `label` is the bar's accessible name; the catalog draws the same sentence under it.
function Captioned({ label, parts }: { label: string; parts: { key: string; value: number; className: string }[] }) {
  return (
    <div className="max-w-2xl">
      <ProportionBar label={label} parts={parts} />
      <p className="mt-2 font-mono text-[10.5px] tracking-[0.04em] text-subtle-foreground">{label}</p>
    </div>
  );
}

export function Catalog() {
  return (
    <Captioned
      label="1,284 artifacts across 12 destinations · 48.0% unobserved"
      parts={[
        { key: "UNOBSERVED", value: 617, className: "bg-state-unobserved" },
        { key: "VERIFIED", value: 588, className: "bg-state-verified" },
        { key: "FAILED", value: 79, className: "bg-state-failed" },
      ]}
    />
  );
}

export function MostlyVerified() {
  return (
    <Captioned
      label="45 artifacts across 1 destination · 6.7% unobserved"
      parts={[
        { key: "UNOBSERVED", value: 3, className: "bg-state-unobserved" },
        { key: "VERIFIED", value: 42, className: "bg-state-verified" },
        { key: "FAILED", value: 0, className: "bg-state-failed" },
      ]}
    />
  );
}
