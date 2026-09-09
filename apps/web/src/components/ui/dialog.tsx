// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "@/components/status-badge";
import type { ArtifactState } from "@/lib/domain";

// The one shape every modal in the product takes. Identity first — WHICH artifact, in its own state,
// before any choice — then the body, then a footer that keeps the gate hint beside the primary
// action, so the reason a button is disabled sits next to the button rather than in a tooltip.
//
// Portaled to document.body for stacking and overflow — and an EVENT BOUNDARY, which the portal
// alone is not. The triggers live inside a row's `<span onClick={preventDefault}>` (which stops a
// click from toggling the <details> row). React bubbles synthetic events through a portal to its
// React ancestors, not its DOM ancestors, so every click inside the dialog still reached that span,
// and its preventDefault cancelled the native default action of whatever was clicked: the submit
// button (the "submit-on-click does not fire" mystery of PR #120 — it fired; it was cancelled), the
// acknowledge checkbox (the box stayed unticked until an unrelated re-render caught the DOM up with
// the state), and the checkbox's label text (label activation is a default action too). Stopping
// propagation at the root keeps a modal's clicks inside the modal. Focus moves inside on open so
// Escape reaches the handler here instead of the page behind.
export function DialogShell({
  titleId,
  title,
  description,
  subject,
  children,
  footerHint,
  actions,
  onClose,
}: {
  titleId: string;
  title: string;
  description?: string;
  subject?: ReactNode;
  children: ReactNode;
  footerHint?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 outline-none"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[calc(100vh-6.5rem)] w-full max-w-xl flex-col rounded-dialog border border-border-region bg-card shadow-dialog">
        <header className="border-b border-border px-6 pt-5 pb-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description !== undefined ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
          {subject !== undefined ? <div className="mt-4">{subject}</div> : null}
        </header>
        <div className="space-y-4 overflow-auto px-6 py-5">{children}</div>
        <footer className="flex flex-wrap items-center gap-3 border-t border-border px-6 py-4">
          <span className="mr-auto font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground">
            {footerHint}
          </span>
          {/* The actions keep to the right even when a blocked reason makes the group wrap. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3">{actions}</div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// The subject row: the artifact's state marker, then what it is, then the machine facts.
export function SubjectRow({
  state,
  name,
  facts,
}: {
  state: ArtifactState;
  name: string;
  facts: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-border-region bg-muted px-3 py-2">
      <StatusBadge state={state} />
      <span className="text-sm font-medium">{name}</span>
      {facts.map((fact) => (
        <span key={fact} className="font-mono text-xs text-muted-foreground">
          {fact}
        </span>
      ))}
    </div>
  );
}
