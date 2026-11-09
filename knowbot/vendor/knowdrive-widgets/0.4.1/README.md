# @recourse-software/knowdrive-widgets

Shared, token-driven CSS for KnowDrive apps — the design-contract §2.1 canonical widgets
(`.card`, `.chip`, `.chipbtn`, `.input`/`.flabel`, `.btn` family, `.data-table`) plus the
GC5/GC16/GC17 patterns (`.drawer`, `.danger-zone`, `.confirm-dialog`, `.field`). Every rule
references theme tokens (`var(--space-*)`, `var(--accent-purple)`, `var(--elev-*)`, …) and
carries no color/geometry literals, so widgets are theme- and mode-responsive
(compact/reading/expressive and light/dark) for free.

## Consuming it

Ships as an **externalized ES module** whose default export is the CSS string (built from
`widgets.css` into `dist/index.js`). A browser importmap can only resolve ES modules, not
`.css` files, so delivering the CSS *as JS* lets the cluster importmap serve **one shared
copy** at `/-/modules/@recourse-software/knowdrive-widgets/dist/index.js` that every app
dedups to. Import it as an ordinary runtime bare specifier, mark it `external` (so it is not
bundled), and concatenate the string into the app's constructable shadow stylesheet **before**
the app's own `bundle.css` (so app-local rules can still override):

```js
import widgets from '@recourse-software/knowdrive-widgets'   // externalized → importmap-resolved
import css from './bundle.css?inline'
const sheet = new CSSStyleSheet()
sheet.replaceSync(`@import url('/-/theme/main.css');\n:host { display:block; }\n${widgets}\n${css}`)
this.shadowRoot.adoptedStyleSheets = [sheet]
```

Add it as a runtime **`dependency`**, add it to the app's `rollupOptions.external`, and (in a
repo using `release.sh`) add it to `INTERNAL_DEPS` so version bumps rewrite the consumer's pin.

**One widget's CSS.** Each `widgets.css` section is also published on its own as
`@recourse-software/knowdrive-widgets/css/<slug>.css` (e.g. `css/file-gauge.css`), for an app
whose own classes collide with the rest of the sheet. It still reads the theme tokens, and is not always self-contained (e.g. `.danger-zone .btn`
relies on the button family's `.btn`).


## Auth widgets (v0.3.0)

Brand-neutral and token-only. They are adapted from the KD Design System auth mockups; the adaptations and
literal mappings are in `theme/design-contract.md` §2.6 and §4.1. The host supplies the logo, product name and
every string.

**CSS** (in the default-export string):
- `.auth-card`, with `-logo`, `-title`, `-sub`, `-body` and `-foot`;
- `.confirm-panel`, with `-medallion`, `-title` and `-body`, plus the `.confirm-panel-success` modifier;
- `.invite-header`, with `-avatar` and `-text`;
- `.pager`, with `-info` and `-btns`;
- `.form-error`.

Use `.btn-dark` for **proceed** actions ("Send reset link") and `.btn-primary` for **create/confirm** actions
("Set new password").

**React** (`@recourse-software/knowdrive-widgets/react`; React is externalized, so keep it in your
`rollupOptions.external`):

```jsx
import { PasswordField, StatusCard, passwordStrength } from '@recourse-software/knowdrive-widgets/react'

<PasswordField
  id="new-password" label="New password" value={pw} onChange={setPw}
  requirements={[
    { id: 'min', label: 'At least 12 characters', test: (v) => [...v.normalize('NFC')].length >= 12 },
    { id: 'max', label: 'At most 128 characters', test: (v) => [...v.normalize('NFC')].length <= 128 },
  ]}
  confirm={{ id: 'confirm-password', label: 'Confirm password', value: pw2, onChange: setPw2 }}
/>

<StatusCard tone="time" title="This link has expired" actions={<a className="link" href="/forgot-password">Send a new link</a>}>
  Reset links expire after 15 minutes.
</StatusCard>
```

- `PasswordField` holds no policy and sets no `maxLength`: your `requirements` are the policy. `onChange` receives the
  string value. One reveal toggle controls both fields. The confirmation stays neutral while it is still a prefix of
  the password. Each requirement's state is announced through visually-hidden text; `metLabel` (default `"met"`)
  and `unmetLabel` (default `"not met"`) localize it. `.sr-only` is also available as a general visually-hidden
  utility.
- `StatusCard` tones are `security` (`role="alert"`), `time`, `info`, `ok` and `neutral` (`role="status"`).
- `passwordStrength(value)` returns 0–4 and drives the meter only.

## Tab strip (v0.3.1)

GC6, partially realized (strip + counts); spec and adaptations in `theme/design-contract.md`
§2.6 "Tab strip" and §4.2. **CSS:** `.tabs`, `.tab` (selected = `[aria-selected="true"]`),
`.tab-count`, `.tab-panel`. Never hand-build a strip from these classes — the selection,
keyboard and ARIA behaviour lives in the component.

```jsx
import { Tabs } from '@recourse-software/knowdrive-widgets/react'

<Tabs
  label="Vector stores"          // the tablist's aria-label
  value={tab} onChange={setTab}  // omit both for uncontrolled (first tab selected)
  tabs={[
    { id: 'stores', label: 'Stores', content: <StoresTable /> },
    { id: 'readme-template', label: 'README template', count: undefined, content: <Panel /> },
  ]}
/>
```

A panel's content mounts the first time its tab is selected and then stays mounted (hidden),
so its state survives switching tabs. Keyboard: ArrowLeft/ArrowRight (wrapping), Home/End.

## File gauge (v0.4.0)

GC12 per file; spec and adaptations in `theme/design-contract.md` §2.6 "File gauge" and §4.3.
Four stage pips (Saved, Text extracted, Full-text, Vector) whose shape is the state, F/V
badges lit when full-text / vector search find the file, an optional label, and a report card
on hover, focus or tap. Never hand-build one from the classes.

```jsx
import { FileGauge } from '@recourse-software/knowdrive-widgets/react'

{file.name} <FileGauge
  phase={file.phase || file.status} tags={file.tags} bytes={file.bytes}
  atomCount={file.atom_count} atomsVectorized={file.atoms_vectorized} // absent or null ≠ 0
  name={file.name} tabIndex={-1}   // in a list: one tab stop per list, not per row
  label                            // show "Searchable" / "Queued" / … after the badges
/>
```

The model is exported too: `fileGauge(input)` → `{ stages, outcome, tone, label, hint, searchable }`,
`gaugeName(view)`, `depthTarget(tags)`. Styles: the whole `widgets.css`, or just
`css/file-gauge.css`; an app without the site tokens defines the ones the section reads,
scoped to `.file-gauge, .file-gauge-card`. The tokens it reads: `--accent-green`, `--accent-purple`,
`--accent-red`, `--text-muted`, `--text-faint`, `--text-accent`, `--text-body`, `--text-heading`,
`--focus-ring`, `--bg-surface`, `--border-base`, `--elev-dropdown`, `--text-2xs`, `--text-xs`,
`--leading-snug`, `--space-1`, `--space-2`, `--space-3`, `--radius-sm`, `--radius-md`.
