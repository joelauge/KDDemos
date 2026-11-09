# Vendored KnowDrive design system

KnowBot Studio (`studio/`) takes KnowDrive's look from these files. They are copies, not links: GitHub Pages serves
this folder at `/vendor/`, and nothing here is fetched from KnowDrive or a CDN at runtime. Re-create every file with
`node scripts/vendor-kd.mjs` (see the header of that script); never edit them by hand, never commit a symlink or a
`node_modules` folder here.

| Folder | Source | Version |
| --- | --- | --- |
| `knowdrive-widgets/0.4.1/` | npm package `@recourse-software/knowdrive-widgets@0.4.1` from the public GitLab registry `https://gitlab.com/api/v4/groups/recoursellm-group/-/packages/npm/` (`dist/`, `widgets.css`, `README.md`, `package.json`, unchanged) | 0.4.1 |
| `kd-theme/tokens.css` | `https://knowdrive.ai/-/theme/main.css`, TOKENS ONLY: the `:root`, `[data-kd-mode]` and `html.dark, .dark` custom-property blocks (116 properties). The global element reset (`*`, `html`, `body`, `a`, `button`, `img`), page chrome and keyframes are left out on purpose. The fetch date and a hash of the source are in the file's header. | fetched 2026-11-09 |
| `react/19.2.9/` | `react@19.2.9` + `react-dom@19.2.9`, production builds, bundled by esbuild 0.25.10 into one ESM file (`react-all.mjs`) with four thin modules for the bare specifiers the widgets import: `react.mjs`, `jsx-runtime.mjs`, `react-dom.mjs`, `react-dom-client.mjs`. MIT licences alongside. | 19.2.9 |

How the Studio uses them (`studio/index.html`, `studio/kdw.js`):

- `kd-theme/tokens.css` and `knowdrive-widgets/<v>/widgets.css` load before the Studio's own CSS; `studio.css` maps the
  Studio's palette, type and spacing variables onto the KnowDrive tokens. Dark mode is KnowDrive's `html.dark` class,
  set together with the Studio's `data-theme="dark"`.
- The `<script type="importmap">` in `studio/index.html` maps `react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client` and `@recourse-software/knowdrive-widgets/react` to these files. `studio/kdw.js` loads them on
  first use only (the first file row or the Set up tabs), so the first paint does not wait for React.

Upstream note (main.css as fetched 2026-11-09): inside the dark block a comment is closed early by the text
`--elev-*/modes`, so browsers drop the dark `--elev-color-sm` declaration; the extractor drops it the same way and
prints a warning, so `tokens.css` renders exactly as `main.css` does.

When bumping a version: run the script with `KDW_VERSION=…` / `REACT_VERSION=…`, update the paths in the importmap
and the `<link>` tags in `studio/index.html`, update this table, delete the old version folder, and run the Studio
smoke (`npm run studio:smoke`).
