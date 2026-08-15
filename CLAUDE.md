# CLAUDE.md

Project-specific instructions. Read [ARCHITECTURE.md](ARCHITECTURE.md) before
making structural changes, and [`docs/README.md`](docs/README.md) before touching
anything data-shaped.

---

## The one rule that matters most

> **`docs/` is a published contract, not commentary. Any change to the data
> model, geometry, rendering behaviour or save format MUST update it in the same
> commit.**

MindFlow's central promise is that a `.mindflow.json` board can be read, written,
validated and rendered **without running MindFlow**. Documentation that lags the
code silently breaks that promise, and nothing else in the project is worth as
much as keeping it true.

### The format is specified in three places that must always agree

| | Where | Audience |
|---|---|---|
| 1 | `docs/*.md` | Humans |
| 2 | `docs/schema/mindflow-<version>.schema.json` | Machines |
| 3 | `src/model/types.ts` + the element registry | The app |

`test/unit/contract.test.ts` fails the build when 2 and 3 disagree, when a
registered type has no section in `docs/03-elements.md`, when an example board
stops validating, or when a round trip stops being stable. It **cannot** check
prose — that part is on you.

### Checklist for any format change

- [ ] `src/model/types.ts` — the TypeScript shape
- [ ] `src/render/shapes/<type>.ts` — `create` and `normalize` handle the field
- [ ] `docs/schema/mindflow-<version>.schema.json` — **a new file if the version
      bumped; published schemas are immutable**
- [ ] `docs/02-document-format.md` and/or `docs/03-elements.md` — the reference
- [ ] `docs/07-rendering.md` — **if the value is computed rather than literal**
- [ ] `docs/CHANGELOG.md` — the version entry, *with a rationale*
- [ ] `src/model/migrate.ts` — a migration, if existing files would break
- [ ] `docs/schema/examples/` — an example exercising the new shape
- [ ] `npm test` passes

### Specify algorithms, not just fields

This is the part that is easy to get wrong. Documenting that a connector has an
`anchor` field is not enough — an `auto` anchor stores *that* it attaches to a
shape, not *where*. If a reader cannot reproduce a rendered result from the file
plus `docs/`, the documentation is incomplete.

Already specified, and the bar for anything new:
auto-anchor resolution, elbow routing, curve smoothing, text wrapping, baseline
placement, arrowhead geometry, dash patterns, grid coarsening.

---

## Non-negotiable invariants

Break these and something subtle fails.

1. **No code outside `src/render/shapes/` may branch on `element.type`.** Use the
   registry. This is what makes new types cheap and the contract testable.
2. **Nothing outside `src/store/commands.ts` may mutate `document.elements`.**
   Every mutation is a command, which is what makes undo correct by construction.
3. **The built page must make zero external requests.** No CDN scripts, no web
   fonts, no remote images. The e2e suite asserts this. The single exception is
   Google Identity Services, injected lazily only after the user clicks "Connect
   Drive".
4. **Never introduce `<script type="module">` into the shipped page.** Module
   fetches are CORS-checked and `file://` has an opaque origin, so it would break
   double-click-to-run — the project's second hard requirement.
5. **`width` and `height` are always strictly positive.** A flipped element uses
   mirrored geometry or a 180° angle, never a negative dimension.
6. **Path elements must be re-normalised after any point change** — see
   `normalizePathBounds`. Skipping it leaves the bounding box describing the old
   extent and breaks culling and hit-testing.
7. **Connectors are never `bindable`.** Binding arrows to arrows creates chains
   with no stable layout fixed point. Enforced by the contract test.
8. **Drive uses `drive.file` and nothing else.** Widening the scope moves it into
   Google's restricted category and requires verification. Do not.

---

## Workflows

```bash
npm run dev         # watch and rebuild; open index.html directly
npm run serve       # watch + http://localhost:8000 (Drive needs an http origin)
npm run build       # produce the single-file index.html
npm run typecheck   # esbuild does NOT type-check — this does
npm test            # unit + contract
npm run test:e2e    # Playwright against the BUILT file over file://
npm run check       # typecheck + test + build
```

- **`index.html` is a committed build artifact.** Run `npm run build` and commit
  it with any `src/` change, or the deployed app silently lags the source.
- **A successful build proves nothing about types.** Always run `npm run
  typecheck` too.
- Delete `test-results/` and `playwright-report/` after an e2e run; never commit
  screenshots.

---

## Conventions

- **Comments explain *why*.** The code already says what. Prefer one paragraph
  explaining a non-obvious tradeoff over five lines restating the syntax.
- **Scene units everywhere.** One scene unit = one CSS pixel at zoom 1. Device
  pixel ratio is applied once when sizing the canvas and never enters element
  geometry.
- **Degrees, clockwise, about the element centre.** Chosen for legibility in raw
  JSON; do not switch to radians for convenience.
- **Overlay chrome divides by zoom.** Handle sizes, hit slop and guide widths are
  screen-pixel constants divided by `zoom` at draw time.
- **Hit tolerance is screen-relative** (`8 / zoom`).
- **Reading is lenient, writing is strict.** The loader coerces, defaults and
  warns; the writer emits canonical output. This asymmetry is what makes the
  format practical to generate from a script or a language model.
- **Gestures recompute from the pointerdown state**, never incrementally from the
  previous frame.
- **New user-facing behaviour needs a test.** Pure logic → Vitest. Anything
  needing a browser → Playwright, against the built file.

---

## Where things live

| Need to change… | Go to |
|---|---|
| A shape's appearance or hit region | `src/render/shapes/<type>.ts` |
| The save format | `src/model/types.ts` + `docs/` + the schema |
| Load leniency or validation | `src/model/document.ts` |
| Undo behaviour | `src/store/commands.ts`, `src/store/history.ts` |
| A gesture | `src/input/controller.ts` |
| Connector routing | `src/input/binding.ts` + `docs/07-rendering.md` |
| A keyboard shortcut | `src/input/keyboard.ts` (and its `SHORTCUT_REFERENCE`) |
| Drive behaviour | `src/io/drive/` + `docs/08-google-drive.md` |
| Anything visual in the chrome | `src/styles/app.css` |

---

## Housekeeping

- Append each prompt to `PROMPT.md`.
- Append a summary of each session's work to `memory/YYYY-MM-DD.md`.
- Record non-obvious gotchas in [LEARNINGS.md](LEARNINGS.md) — especially
  anything that cost real debugging time.
- New or changed environment variables go in `.env.example`.
- Generate a commit message; do not commit unless asked. Never list Claude as an
  author or co-author.
