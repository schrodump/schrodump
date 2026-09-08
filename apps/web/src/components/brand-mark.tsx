// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The Schrödinger-cat mark. The head takes `currentColor`, so it inherits the surrounding text
// colour and reads on either theme without a second asset. The diamond eye is bound to the
// UNOBSERVED state token, not a hard-coded amber: in the product's own vocabulary the eye IS the
// unobserved marker — a cat whose state nobody has looked at yet — so the brand and the ternary
// state stay one colour, and both track the theme. The dash uses the background token so it always
// contrasts with the head. Purely decorative beside the wordmark, hence aria-hidden.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <path
        fill="currentColor"
        d="M122 92 L182 150 L330 150 L390 92 L402 101 L402 360 Q402 430 332 430 L180 430 Q110 430 110 360 L110 101 Z"
      />
      <path style={{ fill: "var(--color-state-unobserved)" }} d="M189 233 L217 261 L189 289 L161 261 Z" />
      <rect style={{ fill: "var(--color-background)" }} x="285" y="250" width="76" height="22" rx="11" />
    </svg>
  );
}
