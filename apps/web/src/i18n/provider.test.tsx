// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider, useT } from "./provider";

function Sample() {
  const t = useT();
  return (
    <div>
      <p>{t("state.unobserved")}</p>
      <p>{t("common.errorDetail", { message: "boom" })}</p>
    </div>
  );
}

describe("i18n", () => {
  it("renders translations from the default (en) locale", () => {
    render(
      <I18nProvider>
        <Sample />
      </I18nProvider>,
    );
    expect(screen.getByText("Unobserved")).toBeInTheDocument();
  });

  it("interpolates placeholders", () => {
    render(
      <I18nProvider>
        <Sample />
      </I18nProvider>,
    );
    expect(screen.getByText("The request failed: boom")).toBeInTheDocument();
  });

  it("renders pt-BR when that is the initial locale", () => {
    render(
      <I18nProvider initialLocale="pt-BR">
        <Sample />
      </I18nProvider>,
    );
    expect(screen.getByText("Não observado")).toBeInTheDocument();
  });

  it("renders es when that is the initial locale", () => {
    render(
      <I18nProvider initialLocale="es">
        <Sample />
      </I18nProvider>,
    );
    expect(screen.getByText("No observado")).toBeInTheDocument();
  });
});
