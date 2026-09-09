// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The dashboard's whole argument in one component. Three equal tiles make "12 verified" the
// loudest thing on the screen, which inverts the product: the number that matters is the one
// nobody has answered yet.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { StateCounters } from "./state-counters";

function renderCounters(counts = { VERIFIED: 12, UNOBSERVED: 2, FAILED: 0 }) {
  return render(
    <I18nProvider>
      <StateCounters counts={counts} />
    </I18nProvider>,
  );
}

describe("StateCounters", () => {
  it("reports all three counts", () => {
    renderCounters();
    expect(screen.getByTestId("count-UNOBSERVED")).toHaveTextContent("2");
    expect(screen.getByTestId("count-VERIFIED")).toHaveTextContent("12");
    expect(screen.getByTestId("count-FAILED")).toHaveTextContent("0");
  });

  it("marks unobserved as the lead figure and the other two as subordinate", () => {
    // Structural, because it is the claim: exactly one of the three leads, and it is never the
    // green one. A future edit that promotes VERIFIED turns this red.
    renderCounters();
    expect(screen.getByTestId("count-UNOBSERVED")).toHaveAttribute("data-lead", "true");
    expect(screen.getByTestId("count-VERIFIED")).toHaveAttribute("data-lead", "false");
    expect(screen.getByTestId("count-FAILED")).toHaveAttribute("data-lead", "false");
  });

  it("keeps the lead when the fleet is fully verified — zero open questions is still the answer", () => {
    // The temptation at 0 unobserved is to promote the green number. That would mean the layout
    // changes shape exactly when an operator has learned to read it one way.
    renderCounters({ VERIFIED: 40, UNOBSERVED: 0, FAILED: 0 });
    expect(screen.getByTestId("count-UNOBSERVED")).toHaveAttribute("data-lead", "true");
    expect(screen.getByTestId("count-UNOBSERVED")).toHaveTextContent("0");
  });

  it("says what an unobserved backup is, next to the number", () => {
    renderCounters();
    expect(screen.getByText(/no verify|questions to answer/i)).toBeInTheDocument();
  });
});

describe("StateCounters — failed is grey until there is something to be red about", () => {
  it("says nothing to answer for at zero, and checked-unusable otherwise", () => {
    const { rerender } = render(
      <I18nProvider>
        <StateCounters counts={{ UNOBSERVED: 2, VERIFIED: 12, FAILED: 0 }} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("count-FAILED")).toHaveTextContent(/nothing to answer for/);
    rerender(
      <I18nProvider>
        <StateCounters counts={{ UNOBSERVED: 2, VERIFIED: 12, FAILED: 3 }} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("count-FAILED")).toHaveTextContent(/checked, unusable/);
  });

  it("says no backups have been written yet when the table is empty", () => {
    render(
      <I18nProvider>
        <StateCounters counts={{ UNOBSERVED: 0, VERIFIED: 0, FAILED: 0 }} total={0} />
      </I18nProvider>,
    );
    expect(screen.getByText("no backups have been written yet")).toBeInTheDocument();
  });
});

