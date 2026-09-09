# Building with SchrodumpDS

**Wrap everything in `<Providers>`.** It supplies React Query and the i18n context (`I18nProvider`, English by default). Components such as `Button`, `ListFooter`, `JobStateChip`, `CronReading`, `LastCheck` and `VerdictPanel` read that context and throw outside it. The root element of a screen gets `bg-background text-foreground font-sans`; put `data-theme="light"` or `data-theme="dark"` on `<html>` to force a theme — by default the tokens follow the viewer's system through `light-dark()`.

```jsx
const { Providers, RuledList, ColumnHeaders, StatusBadge, ListFooter } = window.SchrodumpDS;
<Providers>
  <main className="bg-background text-foreground font-sans p-6">
    <RuledList className="max-w-2xl">
      <ColumnHeaders gridClassName="grid grid-cols-4 items-center gap-3" columns={[{ key: "a", label: "Artifact" }, { key: "s", label: "State" }, { key: "z", label: "Size" }, { key: "w", label: "Written" }]} />
      <div className="grid grid-cols-4 items-center gap-3 border-b border-border px-[18px] py-2.5 text-sm">
        <span className="font-mono text-xs">cmtuga00</span><StatusBadge state="UNOBSERVED" /><span className="font-mono text-xs text-muted-foreground">1.2 GB</span><span className="font-mono text-xs text-subtle-foreground">3 hours ago</span>
      </div>
      <ListFooter shown={1} total={1284} />
    </RuledList>
  </main>
</Providers>
```

**The styling idiom is Tailwind utilities over the domain tokens, precompiled.** The stylesheet is generated ahead of time: a class works only if it is in `_ds_bundle.css`. These families are guaranteed there — use them, and `style={{ color: "var(--state-unobserved)" }}` for anything else:

| Family | Classes |
|---|---|
| Surfaces | `bg-background` `bg-card` `bg-muted` · borders `border-border` (row rule) `border-border-region` (region edge) |
| Ink | `text-foreground` `text-muted-foreground` `text-subtle-foreground` |
| Accent (one hue, three jobs) | `bg-primary text-primary-foreground` (the one main action) · `bg-accent-soft text-accent border-accent-border` (tinted secondary) · `text-caution bg-caution-soft border-caution-border` (persistent warning) |
| Artifact states | `text-state-verified` `text-state-unobserved` `text-state-failed` · `bg-state-*-soft` `border-state-*-border` · fills `bg-state-*` |
| Job outcomes | `text-job-running` `text-job-succeeded` `text-job-pending` `text-job-failed` `text-job-cancelled` `text-job-unknown` |
| Destructive | `bg-destructive text-destructive-foreground` · `text-destructive-text bg-destructive-soft border-destructive-border` |
| Shape | `rounded-chip` `rounded-control` `rounded-panel` `rounded-dialog` · `shadow-card` `shadow-dialog` |
| Type | `font-sans` (Instrument Sans, prose) · `font-mono` (JetBrains Mono, every machine fact: ids, sizes, checksums, states) · the label voice `font-mono text-[10.5px] tracking-[0.13em] uppercase text-subtle-foreground` |
| Layout | `flex` `grid` `grid-cols-{1..6,12}` `gap-{0..12}` `p/px/py/m/mt…-{0..12}` `max-w-{xs..6xl}` `items-*` `justify-*` `space-y-*` `text-{xs..5xl}` · the row gutter `px-[18px]` |

**Laws the components encode — do not work around them.** An artifact is `VERIFIED`, `UNOBSERVED` or `FAILED` and nothing else; UNOBSERVED is amber, never grey, never green, and every state carries a shape (`StatusBadge`, `StateGlyph`). A screen about artifacts leads with the UNOBSERVED count (`StateCounters`). Job outcomes (`JobStateChip`) never borrow the artifact palette. A `Button` is disabled only through `disabledReason`, which renders the reason beside it. Counts come from the server; a truncated list says so (`ListFooter`). Never show a stored secret (`CredentialField`). Every modal is a `DialogShell` with a `SubjectRow` naming what it acts on, and irreversible actions pass a `RetypeToConfirm` or `AcknowledgeCheckbox` gate.

**Where the truth lives.** `styles.css` imports `_ds_bundle.css`, whose `:root` block is the token contract — every `--*` custom property, both themes on one line via `light-dark()` — followed by the compiled utilities. Per component: `components/<group>/<Name>/<Name>.prompt.md` and `<Name>.d.ts`. Groups: primitives, verdicts, lists, forms, dialogs, frames.
