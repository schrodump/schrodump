// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { JobStateChip } from "./job-state-chip";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const chip = (state: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-job-state="${state}"]`);
  if (el === null) throw new Error(`no chip for ${state}`);
  return el;
};

describe("JobStateChip — a process outcome, not a data verdict", () => {
  it("never borrows the artifact palette for SUCCEEDED", () => {
    // A job that succeeded has proven a process did not complain; only the artifact's own marker
    // speaks about whether a backup is good.
    wrap(<JobStateChip state="SUCCEEDED" exitCode={0} />);
    expect(chip("SUCCEEDED").className).toContain("job-succeeded");
    expect(chip("SUCCEEDED").className).not.toMatch(/state-verified|state-unobserved|state-failed/);
  });

  it("colours FAILED, and shows the exit code only when it is non-zero", () => {
    wrap(<JobStateChip state="FAILED" exitCode={2} />);
    expect(chip("FAILED").className).toContain("job-failed");
    expect(chip("FAILED")).toHaveTextContent(/exit 2/);
  });

  it("keeps INCONCLUSIVE as quiet as PENDING — it could not run, it did not fail", () => {
    // The sandbox never got to look; nothing was claimed. Painting it like FAILED is the blur the
    // server refuses on the artifact, one row over.
    wrap(<JobStateChip state="INCONCLUSIVE" exitCode={null} />);
    expect(chip("INCONCLUSIVE").className).toContain("job-unknown");
    expect(chip("INCONCLUSIVE").className).not.toContain("job-failed");
    expect(chip("INCONCLUSIVE")).toHaveTextContent(/could not run/i);
  });

  it("stays silent about exit 0 — the quiet normal", () => {
    wrap(<JobStateChip state="SUCCEEDED" exitCode={0} />);
    expect(screen.queryByText(/exit/i)).toBeNull();
  });
});
