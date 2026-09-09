// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { StateGlyph } from "@schrodump/web";

// The glyph draws in currentColor: on its own it takes the surrounding ink, so the state colour
// comes from the wrapper — exactly how the counters and chips use it.
export function Shapes() {
  return (
    <div className="flex items-center gap-5">
      <span className="text-state-unobserved">
        <StateGlyph state="UNOBSERVED" size={14} />
      </span>
      <span className="text-state-verified">
        <StateGlyph state="VERIFIED" size={14} />
      </span>
      <span className="text-state-failed">
        <StateGlyph state="FAILED" size={14} />
      </span>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex items-center gap-5 text-state-unobserved">
      <StateGlyph state="UNOBSERVED" size={10} />
      <StateGlyph state="UNOBSERVED" size={14} />
      <StateGlyph state="UNOBSERVED" size={20} />
    </div>
  );
}

export function BesideALabel() {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.13em] uppercase text-state-unobserved">
      <StateGlyph state="UNOBSERVED" />
      <span>Unobserved</span>
      <span className="text-2xl font-semibold tracking-normal normal-case text-foreground">617</span>
    </div>
  );
}
