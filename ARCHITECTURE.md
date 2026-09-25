# Architecture

The "why" behind MindFlow's structure. For the **save format** specification, see
[`docs/`](docs/) — that is a separate, versioned contract and the authority on
anything data-shaped.

## The three constraints that shaped everything

Almost every structural decision here traces back to one of these.

### 1. Static hosting, no server

MindFlow is deployed to GitHub Pages as files. There is no backend, no database,
no API. Consequences that show up throughout the code:

- Google OAuth must use the **token flow** (no client secret can exist in a
  static page). See [`src/io/drive/auth.ts`](src/io/drive/auth.ts).
- Persistence is the user's own file system and their own Google Drive.
- There is nowhere to send telemetry, and nothing that wants to.

### 2. Runnable without a server

Double-clicking `index.html` must work. This is the constraint with the least
obvious consequence:

> Browsers fetch `<script type="module">` with CORS semantics, and a page opened
> from `file://` has an opaque origin, so **every module fetch is blocked**.

A page that loads its code from separate module files therefore cannot be run by
double-clicking it. That single fact dictates the build: source is written as
clean TypeScript ES modules, and [`build.mjs`](build.mjs) bundles it to an IIFE
and **inlines everything** — JS and CSS — into one self-contained `index.html`.

The same artifact then works from `file://`, from `npm run serve`, and from
GitHub Pages without modification.

The e2e suite loads the built file over `file://` and asserts that **zero
non-`file://` requests** are made, so this cannot silently regress.

The one exception is Google Identity Services, injected lazily and only after the
user clicks "Connect Drive". Until then no third-party code is loaded.

### 3. The save format is a published contract

Boards must be interpretable **without running the app**. This is why the
element registry exists, why the docs specify algorithms rather than just fields,
and why `test/unit/contract.test.ts` can fail the build.

## Layers

Dependencies point downward only. Nothing in `model/` imports from `ui/`.

```
main.ts
  └── app/            application shell and actions — the only file that knows about everything
       ├── ui/        DOM: toolbar, style panel, text editor, dialogs, menus
       ├── input/     pointer gestures, keyboard, hit-testing, snapping, binding, transforms
       ├── render/    canvas renderer, overlay, image cache, PNG/SVG export
       │    └── shapes/   one module per element type ← the ONLY place that knows about types
       ├── io/        local files, autosave + recent boards, image import, Google Drive
       ├── store/     state, commands, undo/redo
       └── model/     types, registry, geometry, document load/save/validate/migrate
```

## The element registry — the keystone

[`src/model/registry.ts`](src/model/registry.ts) holds one definition per element
type: `create`, `normalize`, `draw`, `hitTest`, and a capability descriptor. A
handful of optional members carry the cases the capability flags cannot express —
`outlineIntersect`, `roughOutline`, `labelBox`, `textRegions`, `withText`,
`wrapsText`, `interiorHandles`, `validate` and `palette`. Each exists because the
alternative was a `type === '…'` branch in code that is not allowed to have one,
and each costs existing types nothing. The dividing line: a fact that is the
same for every element of a type is a flag, and one that depends on the
element's fields (whether a `text` element wraps depends on `autoWidth`) or that
carries type-specific logic or wording is a hook.

When code outside `render/shapes/` needs a narrowed type rather than just a flag,
it uses the capability type guards next to `capabilitiesOf`:

| Guard | Narrows to | Used by |
|---|---|---|
| `isConnector(el)` | `LinearElement` | re-routing, delete clean-up, paste remapping, validation, style panel |
| `isPathElement(el)` | `PathElement` | resize, coordinate rounding |
| `isFrame(el)` | `FrameElement` | `model/frames.ts`, SVG clip paths, the style panel's name row |
| `hasFile(el)` | `ImageElement` | the image cache, copy, file-reference validation |

A flag cannot prove its type's fields, so `contract.test.ts` creates one element
per definition and checks that the fields match the flags. It also compares the
capability matrix in `docs/03-elements.md` against the registry cell by cell.
The guards look definitions up with `findDefinition` and answer `false` for an
unregistered type rather than throwing.

Three `type` branches remain outside `render/shapes/`, each a larger refactor
than a guard: the SVG exporter's per-type `switch` in `render/export.ts`, and the
table-specific rows in `ui/contextMenu.ts` and `ui/stylePanel.ts`.

**The rule: no code outside `render/shapes/` may branch on `element.type`.**

Two things fall out of that discipline:

1. **Adding a shape means writing one file and registering it.** The renderer,
   hit-tester, selection, resize, rotate, grouping, snapping, undo, clipboard,
   autosave and JSON serialisation all work immediately, because none of them
   know what the new type is. [`docs/09-extending.md`](docs/09-extending.md)
   walks through it end to end.

2. **The registry is runtime-inspectable.** TypeScript types vanish at runtime
   and cannot be checked against a JSON Schema; a registry can. That is what
   gives the docs-as-contract rule actual teeth rather than being a promise we
   would inevitably drift away from.

Both `draw` and `hitTest` operate in the element's **local frame** — the renderer
has already applied translation and rotation, and the hit-tester has already
pulled the pointer back through the inverse rotation. Every shape therefore only
deals with an axis-aligned box from `(0,0)` to `(width, height)`. That single
convention removes rotation handling from every shape module.

## Rendering

One `<canvas>`, repainted on demand via `requestAnimationFrame`, skipped entirely
when nothing is dirty.

Repainting everything each frame sounds wasteful, and for a DOM renderer it would
be. For Canvas 2D it is the right default: the GPU-backed context clears and
refills a viewport-sized surface very quickly, and the alternative — tracking
damaged regions — is a large amount of subtle code that mostly buys back what
viewport culling already gives.

**Viewport culling is the one optimisation implemented.** Each element's world
AABB is tested against the visible scene bounds before drawing. On a large board
this skips almost everything.

### Scaling levers, deliberately not built

Reach for these only when profiling demands it:

- **A separate interaction canvas.** Splitting the static scene from the
  selection/handle/guide overlay would avoid repainting the scene while dragging.
  The cost is two surfaces to keep in lockstep.
- **Damaged-region tracking.** Repaint only what changed. Considerable
  complexity; the failure mode (stale pixels) is nasty to debug.
- **Spatial index (quadtree/R-tree).** Culling and hit-testing are currently
  linear scans. At 2,000 elements they are not the bottleneck.

Measured: a 2,000-element board pans and zooms at 60fps with culling alone.
Asserted in the e2e suite so a regression surfaces.

## State and undo

[`src/store/`](src/store/). **Every document mutation is a command**, and nothing
outside `commands.ts` may mutate `document.elements`.

The obvious way to build undo is to snapshot the document before each edit —
simple, always correct, and unaffordable when a board with embedded images is
several megabytes.

Instead a command records `before` and `after` snapshots of **only the elements
it touches**. Inverting is then a field swap, which is correct by construction for
create, delete, update, restyle and reorder alike — rather than hand-writing an
inverse per operation, which is where undo bugs are born.

The second payoff: undo, autosave and dirty-tracking all observe one seam and
cannot drift out of sync, because there is nowhere else to look.

Gestures apply changes as **transient** commands (no history), then replay the
final state as one real command on release — so a drag is one undo step, not
forty.

### What is state, and what is document

The document is what gets saved. Everything else is session state: selection,
active tool, camera. Keeping them apart is what stops a pan from marking the board
dirty or landing on the undo stack.

The viewport is the interesting case: it is *stored* in the file (so a board
reopens where you left it) but is not *document state*. It lives in the store and
is folded into the document only at save time.

### Autosave and recent boards

[`src/io/autosave.ts`](src/io/autosave.ts) keeps a copy of **every** board in
IndexedDB, one per board id, and those copies are the recent-boards menu. It
observes the same store seam as everything else. `app.ts` passes it a snapshot
on `document` and `load` (debounced), and on `saved` (immediate, since only the
copy's `unsaved` flag changes). Nothing in the board lifecycle deletes a copy.
New board, Open and switching boards simply load something else.

Three decisions carry the design:

- **Contents and summaries live in separate stores.** The menu reads small
  summaries only, so opening it never deserialises embedded images.
- **One cached database connection, and a write queue.** IndexedDB orders
  transactions reliably only within a connection. The flush that saves the board
  being left must not be overtaken by the read of the board being opened.
- **A snapshot of a different board flushes the pending one.** Switching boards
  inside the debounce would otherwise drop the last second of edits.

Startup recovery asks about one board only: the one a `session` marker says was
on screen, and only if its copy is unsaved. The marker is written on every
`load`, and once startup has decided. See
[`docs/06-persistence.md`](docs/06-persistence.md#autosave-and-recent-boards).

## Interaction

[`src/input/controller.ts`](src/input/controller.ts) is a single explicit gesture
state machine rather than one class per tool.

A per-tool design was rejected because the interesting gestures **cross** tools:
space-to-pan works while the rectangle tool is active, a middle-drag pans during a
freehand stroke, Escape cancels whatever is in flight. Splitting those across tool
classes means duplicating the shared cases in every one of them.

**Each `pointermove` recomputes from the state captured at `pointerdown`**, never
by applying a delta to the previous frame. Incremental application accumulates
floating-point error across a long drag and, worse, makes a dropped or coalesced
event corrupt the result permanently. A pinch follows the same rule, which is why
the fingers returning to where they started returns the board exactly with them.

**Touch is a property of the gesture, not of the device.** The controller records
`event.pointerType` at `pointerdown`, and the drag threshold, click tolerance and
handle slop all read from it. A media query would be wrong: a tablet driven with
a stylus or a trackpad wants the precise numbers, and owning a touchscreen says
nothing about what is touching it right now. The pinch arithmetic lives in
[`src/input/pinch.ts`](src/input/pinch.ts), free of the DOM, because Playwright
can only drive two simultaneous contacts through raw CDP and the numbers deserve
a unit test.

**Paste has two entry points and one owner.** The Cmd/Ctrl+V keydown
(`input/keyboard.ts`) and the native `paste` event (`app/app.ts`) can both fire
for one press, and pasting is not idempotent. Neither calls `actions.paste()`
directly: both report to [`src/input/pasteGate.ts`](src/input/pasteGate.ts),
created in `app.ts`. The native event takes the press, because it alone carries
image data. The keydown pastes only if no native event arrives within a grace
period, which is what keeps Cmd+V working in WebKit. The gate is DOM-free for the
same reason as the pinch code: Playwright's Chromium only produces one of the
possible arrival orders.

**Keyboard shortcuts are one `window` listener, and overlays opt out by
position.** `input/keyboard.ts` handles keydown on `window` in the bubble phase
and skips only typing targets (inputs, textareas, contenteditable). Anything
else that takes keys has to stop them before they get there.
[`src/ui/popover.ts`](src/ui/popover.ts) does this once for every popover (the
context menu, command palette, find bar, shape flyout and recent-boards menu).
It stops the propagation of unmodified keydowns at the popover root, so
Cmd/Ctrl chords still reach the app. It also takes Escape on `window` in the
*capture* phase, so dismissing a popover never also deselects. The shortcut
handler does not read `defaultPrevented`, so `preventDefault` alone isolates
nothing.

## Text editing

The highest-risk code in the app: two independent text layout engines — Canvas 2D
and a real `<textarea>` — must produce identical line breaks and glyph positions,
or text visibly jumps when editing starts and stops.

These decisions make them agree, documented in
[`src/ui/textEditor.ts`](src/ui/textEditor.ts):

1. **Font size is in scene units; zoom is a CSS transform.** Both engines lay out
   at the same nominal size and scaling happens afterwards, identically.
2. **Identical font stacks** on both sides.
3. **Rotation about the box centre**, with the element positioned by its centre so
   scale and rotate leave it fixed.
4. **The baseline is measured and corrected**, because CSS and the canvas place it
   by different rules.
5. **Whitespace is shown as drawn.** `whitespaceAsDrawn` in
   `render/shapes/shared.ts` turns tabs into the single space the canvas draws,
   on open and on paste.
6. **The canvas breaks lines where the browser does.** `wrapText` breaks after
   a hyphen by Blink's rule (`breaksAfterHyphen`, format 1.6.1), because the
   editor's line breaks come from the browser and cannot be changed. The rule
   is published in `docs/07-rendering.md#hyphens`, so this is a format decision,
   not an editor tweak.

On top of all that, **only one engine draws the text at a time.** While the
editor is open, the renderer paints the element through
`TextEditor.displayed`. That returns a copy without the text under the editor:
all of a note's text, but only one table cell's. The paper, the outline and the
other cells stay on the canvas. It goes through the renderer's `displayed`
option rather than the document, so undo, autosave and the dirty flag never see
it. Agreement between the engines is best effort. This is what stops a small
disagreement from showing up as two overlapping copies of the text.

See [LEARNINGS.md](LEARNINGS.md) for the failure modes this replaced.

## Developer workflows

```bash
npm install

npm run build       # → self-contained index.html at the repo root
npm run dev         # watch + rebuild; open index.html directly, refresh manually
npm run serve       # watch + http://localhost:8000 (needed for Drive: no OAuth on file://)

npm run typecheck   # tsc --noEmit; esbuild does not type-check
npm test            # vitest — pure logic, node environment, no DOM
npm run test:e2e    # playwright against the BUILT index.html over file://
npm run check       # typecheck + unit + build, in that order
```

Two non-obvious points:

- **`index.html` is a committed build artifact.** It is what GitHub Pages serves
  and what users double-click. Rebuild and commit it with any `src/` change.
- **esbuild does not type-check.** A build succeeding proves nothing about types;
  run `npm run typecheck` (or `npm run check`).

### Deployment

GitHub Pages, **source: `main` branch, `/` (root)**.

> Do **not** point Pages at `/docs` — that folder holds the format documentation,
> and Pages would publish the docs instead of the app.

`.nojekyll` at the root stops Jekyll from processing the site.

## Testing strategy

| Layer | Tool | Scope |
|---|---|---|
| Pure logic | Vitest (node) | Geometry, commands, history, document load/save, migrations, bindings, transforms |
| Contract | Vitest | Registry ↔ schema ↔ docs agreement; example validation and round-tripping |
| End to end | Playwright | The built `index.html` over `file://`, driven with real pointer events |

The unit environment is **node, not jsdom**, deliberately: the modules under test
have no DOM dependency and that constraint is worth keeping enforced. Anything
genuinely needing a browser goes in the Playwright suite.

### The contract test

[`test/unit/contract.test.ts`](test/unit/contract.test.ts) is the mechanism that
keeps documentation honest. It fails the build when:

- the element registry and the JSON Schema disagree about which types exist;
- a registered type has no `## ` section or capability-matrix row in
  `docs/03-elements.md`, or the matrix still lists a type that was removed;
- an example board stops validating against the schema;
- an example stops round-tripping (`load → save → load` must be stable);
- a board holding a retired type stops migrating to one the current schema
  accepts;
- a connector becomes bindable (which would create unresolvable binding chains).

It cannot check prose. That part is on the author.

## Project-specific conventions

- **Scene units everywhere.** One scene unit = one CSS pixel at zoom 1. Device
  pixel ratio is applied once when sizing the canvas backing store and never
  enters element geometry.
- **Degrees, not radians**, clockwise, about the element centre. Chosen for
  legibility in raw JSON.
- **Overlay chrome is divided by zoom.** Handle sizes, hit slop and guide widths
  are screen-pixel constants divided by `zoom` at draw time. That single division
  is the whole trick to zoom-invariant UI on a transformed canvas.
- **Hit tolerance is screen-relative** (`8 / zoom`), so a hairline is equally
  clickable at any zoom.
- **Reading is lenient, writing is strict.** The loader coerces, defaults and
  warns; the writer emits canonical output. This is what makes the format
  practical to generate from a script or a language model.
- **Comments explain *why*.** The what is in the code.

## Dependencies

Runtime: **none.** The shipped page contains no third-party code.

Development: esbuild (bundling), TypeScript (checking), Vitest + Ajv (unit and
contract tests), Playwright (e2e). Nothing is loaded from a CDN at runtime — a
strict requirement, since the page must work offline and from a local file.

Icons are from [Lucide](https://lucide.dev) ([ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE)),
extracted at build time rather than fetched at runtime.
[`scripts/build-icons.mjs`](scripts/build-icons.mjs) reads them from the
`lucide-static` devDependency through a strict element and attribute whitelist
and writes [`src/ui/icons.ts`](src/ui/icons.ts): a generated file, committed
like `index.html` and marked `DO NOT EDIT BY HAND`. The markup is inlined into
the bundle, so the shipped page still runs no third-party code and loads
nothing from a CDN. To add an icon, add a line to the manifest in
`scripts/build-icons.mjs` and run `npm run icons`.
[`test/unit/icons.test.ts`](test/unit/icons.test.ts) regenerates the file in
memory and fails if the committed copy has drifted from the manifest.
