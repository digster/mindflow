# Prompt log

A record of the prompts that drove this project, kept for context and
reproducibility.

---

## 2026-08-15 — Initial build

> - i want to create a digital whiteboarding tool ala freeform + excalidraw + tldraw.
> - it wont have concurrent collabaration features.
> - it will be html only and should be runnable without a server(we will be hosting it via static github pages).
> - add a nojekyll file as well.
> - the way we want to go about the feature scope is to start with the basic features and add more as we move ahead.
> - give me the options for the feature set to start with.
> - we should be able to save and load indivdual project files.
> - the complete interpretation/architecture of our app(objects, positioning, attributes, interactions etc) including the save files should be well documented inside a 'docs' folder(any new features or changes should always update these contract docs, update this in the project claude file).
> - the aim is to clearly interpret the save files and the app as a whole outside of the running app(for extensability and documentation purposes), think programmatic compatibility with llms.
> - add a google drive integration as well, make sure we only ask for as little permissions as possible to get the integration working, it should be able to work off a single folder saved in the drive that we last used.

### Decisions taken in response

Four options were presented and chosen:

| Question | Choice |
|---|---|
| V1 feature scope | **Standard whiteboard** — core canvas plus sticky notes, images, grouping, snapping, bound connectors, shape labels, PNG/SVG export |
| Build approach | **Bundle to a single file** — TypeScript ES modules in `src/`, esbuild inlines everything into one `index.html` |
| Renderer | **Canvas 2D** with a DOM overlay for text editing |
| Drive scope | **Auto-created folder only**, `drive.file` scope, OAuth Client ID only |

### Two constraints surfaced during planning

1. **`file://` blocks ES modules.** Browsers fetch module scripts with CORS
   semantics and a local page has an opaque origin, so "runnable without a
   server" rules out shipping module scripts. This dictated the single-file
   inlining build.
2. **OAuth cannot work from `file://`.** A double-clicked page reports origin
   `null`, which Google will not accept. Drive is therefore an HTTP(S)-only
   feature — documented as a boundary rather than worked around.

> implement the plan.

Delivered: the full application, the `docs/` contract, a JSON Schema with
examples, 183 unit/contract tests and 23 end-to-end tests against the built
artifact.

---

## 2026-08-15 — Two bug reports

> * While typing text (cursor is blinking and active) the text looks weird, but
>   once the typing mode is exited, it looks normal.
> * Objects once locked can't be selected and unlocked again.

Both fixed. The first was a baseline mismatch between the canvas renderer and the
DOM text editor; the second was a one-way door created by three individually
reasonable decisions about locked elements.

---

## 2026-08-16 — New board discoverability

> How do I create a new blank board? Do not change anything in the repo yet.

Answered from the source: `Cmd/Ctrl+N` → `Application.newBoard()` → `store.reset()`.
The investigation turned up two things worth acting on — the top bar had no New
button at all (`ToolbarCallbacks.onNew` was wired up but never rendered), and the
shortcut is one browsers reserve for "new window", so it usually never reaches
the page.

> Yes, add it.

Added the New board button to the top bar, plus the honest documentation of the
shortcut's limits that the button's existence implies.

> ok, look at the text-editor one.

The suspected bug (a floating editor over the new board) did not reproduce in
Chromium, but the investigation found a real one underneath: `TextEditor.commit`
dirtied the board for edits that changed nothing, because `Store.execute` detects
no-op commands by reference and `commit` always rebuilds the element. Fixed with
a `touched` flag, plus a defensive editor close on both document-swap paths.

---

> Suggest the next set of features to add. Do not change anything in the repo yet.

Read the README, ARCHITECTURE, docs contract and both memory files, then surveyed
the source. Proposed three tiers, led by a finding: `Actions.align` was fully
implemented and had no caller — the same defect class as the New board button.

> Create a plan for the tier one and tier two features.

Explored the affected surfaces and wrote a plan. Decisions taken with the user:
all three Tier 2 features, two batches on one branch, and one shared popover
module rather than three bespoke overlays.

> implement the plan.

Implemented both batches. Tier 1: fixed and exposed align (plus distribute), a
context menu, a command palette, find on board, and a style clipboard. Tier 2:
schema 1.1.0 (`diamond` and hand-drawn rendering) and 1.2.0 (`frame`), plus the
registry extension points both needed and two contract-test gaps they exposed.

> [screenshot of the Settings dialog] i am able to type in this field but not
> paste anything, look into it.

Traced it to the window-level native `paste` listener calling `preventDefault`
on pastes that had bubbled out of a focused field. Fixed by sharing the
keyboard handler's `isTypingTarget` guard. Affected all five chrome inputs, not
just Settings.

> ok, work on the drop listener edge case.

Correction first: the drop listener was on the canvas, not `window` as reported
in the previous turn, so the failure was the opposite of the one described —
files dropped anywhere outside the canvas reached no handler and the browser
navigated to them, discarding the board. Moved both listeners to `window`,
suppressing the default page-wide and handling images at the viewport centre
when the drop lands on the chrome. Drops over a modal are swallowed; non-file
drags are untouched.

> add a table object that can be used.

Added a `table` element type end to end: schema 1.3.0, the shape module, per-cell
text editing with `Tab` navigation, draggable column and row dividers,
insert/delete from the context menu, SVG export, docs and tests. Two new
registry extension points fell out of it — `textRegions` (an element owning many
independent blocks of text) and `interiorHandles` (draggable dividers inside an
element's box) — both optional, so no existing type changed.

Building the per-cell undo test uncovered a pre-existing bug: undoing a text edit
had never worked, for any element type. `TextEditor.commit` rewound to the
element it read back out of the document, which `onInput` had already
overwritten. Fixed, with two regression tests on a sticky note.

> work on the following as 2 separate commits -
> * add color support in our app
> * the current icons look very amateur, use some free icons now and in the future

**Commit 1 — colour.** The format had been colour-complete since 1.0.0; the UI
exposed two of its colour fields. Added a text colour row (writing `color` or
`label.color` depending on the type), a table header fill row, and a board
background picker in the top bar, which finally gave `PALETTE.canvas` — defined
since the first commit and referenced by nothing — a caller. Replaced the raw
`<input type="color">` at the end of each swatch row with a popover carrying the
palette, a recent-colours strip and a hex field. Types can now declare their own
palette on their registry definition, so a sticky note offers paper tones without
anything branching on `element.type`.

**Commit 2 — icons.** Replaced the 46 hand-written path strings with Lucide
(ISC), extracted at build time by `scripts/build-icons.mjs` from a devDependency
so the page still makes zero external requests. `icon()` now takes inner markup
rather than a single path's `d`, because real icons need several elements.
Building the extractor's whitelist test caught a silent bug in the extractor
itself: attribute names containing digits (`x1`, `y1`) matched nothing and were
dropped, so the frame icon had been generated as four empty `<line />` elements.

> - add some basic 3d shapes
> - while working with a touch device like an ipad, if the cursor in the text box
>   is active and i click elsewhere or select something else, the cursor is still
>   active.
> - Also, the text box selecting and dragging does not seem to work well(on touch
>   devices).
> - do the 3 changes in different commits

Scoped in conversation to thirteen new element types (five flat polygons, eight
solids), reached through a new shape flyout rather than thirteen more toolbar
buttons, plus a fourth commit adding the two-finger pan and pinch-to-zoom a
touchscreen otherwise has no way to reach.

**Commit 1 — shapes.** Schema 1.4.0. `triangle`, `pentagon`, `hexagon`, `star`,
`parallelogram`, `cube`, `cylinder`, `cone`, `pyramid`, `sphere`, `prism`,
`torus`, `capsule`. None adds a field: a polygon's vertices are fractions of the
box, and a solid's depth is computed (`0.25 × min(w, h)`) rather than stored, so
resizing one is the ordinary base-geometry change every other type gets. Faces
derive lit and shaded tones from the element's single `fill`. One new optional
registry member, `labelBox`, puts a solid's label on its front face in all three
renderers at once.

**Commit 2 — the caret that would not go away.** The canvas press handler
carried a comment saying it committed the editor and only cleared a store flag;
the editor actually closed as a side effect of a native focus change, which a
touch screen does not reliably cause. It now commits explicitly, a window-level
listener covers presses on the chrome, `commit()` blurs before hiding so the
soft keyboard goes down, and `open()` focuses inside the gesture so it comes up.

**Commit 3 — selecting and dragging by touch.** Every input constant had been
sized for a mouse. The drag threshold, the click tolerance and the handle slop
now read from the pointer type of the gesture in progress. `pointercancel`
became a real teardown that rewinds what the gesture had applied and releases
the capture. Double tap opens the text editor, since `dblclick` does not arrive
reliably from a finger, and a long press opens the context menu instead of being
swallowed by the move it had already started.

**Commit 4 — pan and pinch.** Not part of the three, and the third made it
impossible to leave out: `touch-action: none` means nothing pans or zooms unless
the app does, so a touchscreen could only zoom from the toolbar. A second finger
abandons the first one's gesture and starts a pinch, recomputed from the captured
start like every other gesture. The arithmetic is a pure function so it can be
unit-tested, since two simultaneous contacts need raw CDP.

---

## 2026-09-22 — Fewer solids, and a collapsible style panel

> * remove the following 3d shapes - prism, sphere, torus, capsule.
> * allow the property right sidebar to be collapsible so that on smaller screens
>   like the ipad we have more screen real estate.
> * All changes as separate commits.

**Commit 1 — retire four solids.** Schema 1.5.0. `sphere`, `prism`, `torus` and
`capsule` leave the registry, the flyout, the icon manifest and the schema, and
the torus takes the even-odd hole machinery with it. Removed from the format, not
merely hidden, with a 1.4.0 → 1.5.0 migration that turns any on an old board into
the flat shape of its outline (ellipse, ellipse, triangle, pill-rounded
rectangle) — without it, the unknown-type rule would have kept them in the file
but stopped drawing them. The contract test gained the reverse of its docs check,
which is how stale documentation for a removed type would otherwise have slipped
through.
