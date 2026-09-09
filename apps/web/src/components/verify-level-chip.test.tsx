// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { VerifyLevelChip } from "./verify-level-chip";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

describe("VerifyLevelChip — how deep the check went, never whether it passed", () => {
  it("names a full restore without any verdict colour", () => {
    wrap(<VerifyLevelChip level="FULL_RESTORE" degraded={false} state="VERIFIED" />);
    const chip = screen.getByTestId("verify-level-FULL_RESTORE");
    // Beside a red FAILED, a green "full restore" would read as "the restore passed".
    expect(chip.className).not.toMatch(/state-verified|state-failed|caution/);
  });

  it("reads a DOWNGRADED checksum as a caution, distinct from a requested one", () => {
    wrap(<VerifyLevelChip level="CHECKSUM" degraded state="VERIFIED" />);
    const chip = screen.getByTestId("verify-level-CHECKSUM-degraded");
    expect(chip).toHaveAttribute("data-caution", "true");
    expect(chip.className).toContain("caution");
    expect(chip).toHaveAttribute("title");
  });

  it("keeps a requested checksum neutral", () => {
    wrap(<VerifyLevelChip level="CHECKSUM" degraded={false} state="VERIFIED" />);
    expect(screen.getByTestId("verify-level-CHECKSUM").className).not.toContain("caution");
    expect(screen.queryByTestId("verify-level-CHECKSUM-degraded")).toBeNull();
  });

  it("says 'no verdict yet' for an unobserved artifact with no level", () => {
    wrap(<VerifyLevelChip level={null} degraded={false} state="UNOBSERVED" />);
    expect(screen.getByTestId("verify-level-none")).toHaveTextContent(/no verdict yet/i);
  });

  it("says nothing for a verified or failed artifact that predates the field", () => {
    // "checksum" there would be a false claim, and "no verdict" a false one too.
    const { container } = wrap(
      <VerifyLevelChip level={null} degraded={false} state="VERIFIED" />,
    );
    expect(container.querySelector("[data-testid^='verify-level']")).toBeNull();
  });
});
