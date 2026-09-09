// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// Deletion is irreversible and reaches the bucket. The UI is the second lock (the server refuses a
// viewer regardless), and the friction — retype the id, and for a VERIFIED artifact tick an extra
// acknowledgement — is the guard against a reflexive click throwing away a proven-good backup.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { api } from "@/lib/api";
import type { Artifact } from "@/lib/types";
import { DeleteArtifactButton, DeleteArtifactDialog } from "./delete-artifact-dialog";

// Observe the delete without a real fetch.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(() => Promise.resolve(undefined)) },
}));

const base: Artifact = {
  id: "art01234deadbeef",
  jobId: "job-1",
  destinationId: "destination-1",
  targetName: null,
  policyName: null,
  state: "FAILED",
  verifiedLevel: null,
  verifiedDegraded: false,
  bucketKey: "org/shop/2026-01-01.archive",
  manifestKey: "org/shop/2026-01-01.manifest.json",
  engine: "postgres",
  executionMode: "STREAM",
  sourceHasOplog: null,
  dumpIsMultiDatabase: null,
  serverVersionNum: 160_002,
  sizeRawBytes: 4096,
  sizeCompressedBytes: 1024,
  checksumAlgorithm: "sha256",
  checksum: "deadbeef",
  compression: "zstd",
  keyIds: ["age1operational"],
  dependsOn: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const token = base.id.slice(0, 8);

function wrap(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const submit = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /delete permanently/i }) as HTMLButtonElement;

describe("DeleteArtifactButton visibility", () => {
  it("is hidden for a viewer", () => {
    wrap(<DeleteArtifactButton artifact={base} role="viewer" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is shown for an operator", () => {
    wrap(<DeleteArtifactButton artifact={base} role="operator" />);
    expect(screen.getByRole("button")).toBeTruthy();
  });
});

describe("DeleteArtifactDialog gating", () => {
  it("keeps delete disabled until the id is retyped exactly (FAILED needs no acknowledgement)", () => {
    wrap(<DeleteArtifactDialog artifact={base} onClose={() => undefined} />);
    // No acknowledgement checkbox for a non-VERIFIED artifact.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong" } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: token } });
    expect(submit().disabled).toBe(false);
  });

  it("requires BOTH the retyped id and the acknowledgement for a VERIFIED artifact", () => {
    wrap(<DeleteArtifactDialog artifact={{ ...base, state: "VERIFIED" }} onClose={() => undefined} />);
    const ack = screen.getByRole("checkbox");
    expect(submit().disabled).toBe(true);
    // Right id, no acknowledgement → still blocked.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: token } });
    expect(submit().disabled).toBe(true);
    // Acknowledgement, but now clear the id → blocked again (both are required, not either).
    fireEvent.click(ack);
    expect(submit().disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(submit().disabled).toBe(true);
  });
});

// The bug this fixes, seen in production: the trigger lives in the artifact row inside a
// `<span onClick={preventDefault}>` (which stops a click from toggling the <details> row). An inline
// dialog is a DOM descendant of that span, so a click on the submit button bubbled up to it and
// preventDefault silently cancelled the form submit — enabled button, no request, no error. The fix
// is to portal the dialog out of that subtree. Asserting the STRUCTURE (the dialog is not a
// descendant of a wrapper around it) is the reliable, mutation-provable guard: revert the portal and
// the dialog lands back inside the wrapper and this fails.
describe("DeleteArtifactDialog escapes a preventDefault wrapper via a portal", () => {
  it("does not render as a descendant of the element that wraps it", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <div data-testid="row-wrapper" onClick={(event) => event.preventDefault()}>
            <DeleteArtifactDialog artifact={base} onClose={() => undefined} />
          </div>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole("dialog");
    const wrapper = screen.getByTestId("row-wrapper");
    // Portaled to document.body, so a click on its submit button never bubbles to the wrapper's
    // preventDefault. If it were inline, wrapper.contains(dialog) would be true.
    expect(wrapper.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});

// The production bug: clicking the confirm button did nothing — no request, no error — because a
// click on a type="submit" button did not fire the form's submit in the real stack (only
// requestSubmit did). The fix drives the delete from the button's onClick, like the Verify button.
// jsdom does NOT reproduce the real-browser bug (fireEvent.click here fires the form submit), so
// this cannot mutation-prove that specific defect; it guards the behaviour that matters — a click
// with a matching token fires the delete with the right arguments.
describe("DeleteArtifactDialog fires the delete on a button click", () => {
  it("calls the delete API when the confirm button is clicked", async () => {
    wrap(<DeleteArtifactDialog artifact={base} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: /delete permanently/i }));
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(`/artifacts/${base.id}`, {
        acknowledgeVerified: false,
      }),
    );
  });
});
