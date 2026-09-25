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

**Commit 2 — a collapsible style panel.** The panel gained a header naming the
selection and a toggle that shrinks it to a single button, remembered per
browser; `Cmd`/`Ctrl` + `\` and a command-palette entry do the same. It also
stopped spanning the full height regardless of content — it now hugs its
controls — which on its own hands back most of the right-hand column for a short
selection. On a coarse pointer the toggle grows to 40px.

---

## 2026-09-23 — Stale icon note in ARCHITECTURE.md

> `ARCHITECTURE.md`, in its closing "Dependencies" section, still says:
>
> > Icons are hand-written SVG paths in `src/ui/icons.ts` rather than a library,
> > for the same reason.
>
> That stopped being true when icons moved to Lucide. `src/ui/icons.ts` is now a
> **generated, committed build artifact**: `scripts/build-icons.mjs` pulls the
> icons from the `lucide-static` devDependency through a strict element and
> attribute whitelist, and writes the file with a `DO NOT EDIT BY HAND` banner.
> `npm run icons` regenerates it, and a unit test (`test/unit/icons.test.ts`)
> regenerates it in memory and fails on drift. The shipped page still makes zero
> external requests, because the extraction happens at build time and the output
> is inlined.
>
> Replace that sentence with an accurate short paragraph covering:
> - icons are Lucide (ISC), extracted at build time from a devDependency and
>   committed, so there is still no runtime third-party code and no CDN;
> - to add an icon, add a line to the manifest in `scripts/build-icons.mjs` and
>   run `npm run icons`;
> - the drift test.
>
> Check `CLAUDE.md`, `README.md` (its "Credits" section) and `LEARNINGS.md` for
> wording to stay consistent with. This is a documentation-only change: no code
> changes and no rebuild of `index.html`. Per the repo's housekeeping rules,
> append the prompt to `PROMPT.md` and a short note to that day's
> `memory/YYYY-MM-DD.md`.

Replaced the sentence with one paragraph, worded to match `CLAUDE.md`'s
workflow note and the README's Credits section. Documentation only.

---

## 2026-09-23 — Copy and paste produced two copies

> Selecting, copying and then pasting a selected object creates two copies of it.

Cmd/Ctrl+V pasted from the keydown and again from the native `paste` event the
same chord fires. The two now report to a small gate (`src/input/pasteGate.ts`)
that lets exactly one of them paste per press.

---

## 2026-09-23 — Recent boards from the logo

> When clicking on the icon beside the board name(top left), we should be able to
> select any of the recent boards if they still persist in the local storage
> (similar to when we open mindflow for the first time and if there is a board in
> the local storage, we give an option to recover it).

Autosave kept one record in total and deleted it on every save, New board and
Open, so there was never more than one board to list. It now keeps a copy per
board (capped at ten), and the logo opens a menu of them. Decisions confirmed
with the user: list every recent board, not only unsaved ones; leaving a board
keeps its copy; declining startup recovery ("Start blank") keeps it too, and
only the board on screen at the end of the last session is ever offered.

---

## 2026-09-23 — Arrow keys in the context menu nudged the selection

> In MindFlow, arrow keys pressed while the right-click context menu is open also
> nudge the selected element on the board. […] Task: apply the same isolation to
> the context menu, ideally by moving it into the shared `Popover` class, or
> behind an option on it, so every popover gets it. Check that the command
> palette and find bar still work […]. Then remove the now-redundant local
> listener in `recentBoards.ts`. Add a Playwright e2e test in
> `test/e2e/board.spec.ts` ("context menu" describe block): right-click a shape,
> press ArrowDown, and assert the element did not move. […] Rebuild with
> `npm run build` and commit the built `index.html` with the change, run
> `npm run typecheck`, `npm test` and `npm run test:e2e`, and add a LEARNINGS.md
> entry. Generate a commit message but do not commit.

`Popover` now stops the propagation of every keydown without Cmd/Ctrl at its
root, so all five popovers get it. The recent-boards menu's local copy of the
listener is gone.

---

## 2026-09-23 — Jittery bound shapes, and arrow starts that ignore where they were drawn

> * When an arrow is attached to an object and we then move the object, the
>   object is very jittery/vibrates while moving.
> * Consider two objects, one source and the other target. When we try to attach
>   an arrow from the source to the target, after the placement, the arrow end
>   for the target rests where it was placed, but for the source, the beginning
>   point of the arrow is relocated to some common point near the source object
>   irrespective of where it was placed(excalidraw does it correctly, respecting
>   where the beginning and end points of the arrow where placed).
> * Work on this as separate comments.

The jitter was object snapping aligning a shape to its own bound arrow, which is
re-routed from that shape every frame. Bound connectors are now excluded from
snapping for the drag. The arrow start was an `auto` anchor, which cannot
remember a drop point. Format 1.6.0 adds a `focus` anchor for drops inside a
shape. Decisions confirmed with the user: the aim-point anchor with a format
bump (over pinning to the outline with no format change), and near-centre drops
still snap to `auto`.

---

## 2026-09-23 — Registry-driven connector checks in `binding.ts`

> In /Users/ishan/lab/mindflow, CLAUDE.md invariant #1 says: "No code outside
> `src/render/shapes/` may branch on `element.type`. Use the registry." Two
> functions in `src/input/binding.ts` violate it:
>
> - `connectorsToRefresh` has `if (element.type !== 'line' && element.type !== 'arrow') continue;`
> - `connectorsBoundTo` filters with `(el.type === 'line' || el.type === 'arrow')`
>
> Both only need to know "is this element a connector with bindings?". Replace
> the type checks with a registry-driven predicate. Options: use
> `capabilitiesOf(el)` from `src/model/registry.ts` (connectors have
> `path: true` and `bindable: false`, but `draw` is also
> `path: true`/`bindable: false`, so that pair alone is not enough), or add an
> explicit capability flag such as `connector: true` to the registry's
> capability descriptor and set it in `src/render/shapes/linear.ts` only. If you
> add a capability, the contract test `test/unit/contract.test.ts` checks that
> every definition declares a complete capability set (the `required` list in
> "every definition declares a complete capability set"), so update that list
> and every shape definition in `src/render/shapes/`. A cheaper alternative is to
> test for the presence of the `startBinding`/`endBinding` fields structurally
> (`'startBinding' in el`), which needs no registry change. Pick whichever reads
> cleanest and explain the choice in a comment.
>
> Also grep `src/` (outside `src/render/shapes/`) for any other `.type ===` /
> `.type !==` comparisons against element type names and fix them the same way.
> Do not change behaviour. Run `npm run typecheck`, `npm test`, `npm run build`
> (index.html is a committed build artifact), and `npm run test:e2e`; delete
> `test-results/` and `playwright-report/` afterwards. Per the project's
> housekeeping rules, append the prompt to PROMPT.md, a summary to
> memory/YYYY-MM-DD.md, and generate a commit message without committing (never
> list Claude as an author).

The grep found about 35 comparisons in 11 files, far more than two. Scope was
confirmed with the user: connector + path sites only. They became a new
`connector` capability, with `isConnector` / `isPathElement` guards in
`registry.ts`. Frame, image, fillable, text autoWidth, draw validation, table UI
and the SVG exporter's switch were left as follow-ups.

---

## 2026-09-23 — The remaining predicate-shaped type branches

> In /Users/ishan/lab/mindflow, CLAUDE.md invariant #1 says no code outside
> `src/render/shapes/` may branch on `element.type`. A previous session added a
> `connector` capability and two type guards in `src/model/registry.ts`
> (`isConnector(el): el is LinearElement`, `isPathElement(el): el is PathElement`,
> both using `findDefinition(...)?.capabilities.X === true` so unregistered types
> answer false instead of throwing). `test/unit/contract.test.ts` has a test, "the
> connector and path flags match the fields they promise", that creates one
> element per definition and checks the flags against the fields, which backs the
> guards' narrowing. Read LEARNINGS.md's entry "Swapping a `type ===` branch for a
> capability can quietly change two things" first.
>
> Convert the remaining PREDICATE-SHAPED violations the same way, with no
> behaviour change:
> - Frame: `src/model/frames.ts` (5 sites), `src/ui/stylePanel.ts:203` (name row),
>   `src/render/export.ts:575,584` (clip paths).
> - Image: `src/render/images.ts:36,77`, `src/app/actions.ts:192`,
>   `src/model/document.ts:472,496`.
> - Fillable: `src/ui/stylePanel.ts:197` (`!draw && !line && !arrow && !text`). No
>   existing flag combination matches; sticky and table have `text: true` but are
>   fillable.
> - Text autoWidth: `src/ui/textEditor.ts:360,433,487`.
> - Draw validation: `src/model/document.ts:468`.
> For each, decide between a new capability flag (update `ElementCapabilities`,
> every capability block in `src/render/shapes/`, the `required` list in the
> contract test, and the capability matrix plus bullets in `docs/03-elements.md`
> and the flag table in `docs/09-extending.md`), a type guard, or an optional
> definition hook. Explain the choice in a comment. Add a contract assertion for
> any new narrowing guard.
>
> Out of scope (larger refactors; ask before touching): the SVG exporter's
> `switch (element.type)` at `src/render/export.ts:393` and the table UI in
> `src/ui/contextMenu.ts:67` / `src/ui/stylePanel.ts:212`.
>
> Run `npm run typecheck`, `npm test`, `npm run build` (index.html is a committed
> artifact), and `npm run test:e2e`; delete `test-results/` and
> `playwright-report/`. Do not run `npm run serve`/`dev` without rebuilding
> afterwards (they overwrite index.html). Append the prompt to PROMPT.md and a
> summary to memory/YYYY-MM-DD.md, update ARCHITECTURE.md's registry section if a
> new guard is added, and generate a commit message without committing (never
> list Claude as author).

Result: three flags (`frame`, `file`, `fillable`), two guards (`isFrame`,
`hasFile`) and three hooks (`withText`, `wrapsText`, `validate`). Only the three
out-of-scope branches remain.

---

## 2026-09-24 — Sticky text garbled while editing

> [three screenshots: a long tab-indented sticky note rendered normally; the same
> note double-clicked, with a second, offset copy of every indented line showing
> through the selection; and with the caret active, garbled the same way]
>
> * this is about an issue when the text in a sticky is more, it does not happen
>   when the content is less.
> * in normal display the text appears fine but it appears garbled when - the
>   sticky is double clicked to select or the cursor is active to type.

The canvas never hid the text under the editor, so both engines drew it. The
note's tab-indented lines, the indents `wrapText` dropped, and a `select()`
scroll were what made the two copies disagree.

---

## 2026-09-24 — Hyphen line breaks: canvas vs editor

> In MindFlow, the canvas text wrapper and the DOM text editor break lines
> differently around hyphens. `wrapText` […] breaks only at spaces, plus
> character-breaking for a single over-wide word. The editor is a `<textarea>`
> with `white-space: pre-wrap; overflow-wrap: break-word` […]. Chromium's
> textarea also breaks after a hyphen […]. Task: decide how to make the two
> agree, then implement it. […] Options: (a) Teach `wrapText` to also break
> after a hyphen-minus that follows a letter, closer to UAX #14 […]. (b) Stop
> the textarea breaking after hyphens […] showing U+2011 in the editor and
> mapping it back on write […]. Ask the user which they prefer before
> implementing […]. Then write a failing test first […]. Rebuild […], run
> typecheck, test and playwright […]. Append the prompt to PROMPT.md and a
> summary to memory/YYYY-MM-DD.md, then generate a commit message without
> committing.

Chosen: (a), hyphen only, as format 1.6.1. The rule is Blink's as measured
("follows a letter" would have missed `2024-09`, `a--b` and `-foo`, which
Blink also breaks).

---

## 2026-09-25 — Block page zoom on touch devices

> block the site zoom on touch devices, not the board zoom.

A pinch on the top bar or tool palette zoomed the whole page on a touchscreen
(4× in Playwright's desktop-Chrome-with-touch project, which ignores the
viewport meta, as iOS Safari does for a pinch). Blocked with `touch-action:
pan-x pan-y` on the page and each scroller, WebKit `gesture*` cancellation on
touch devices, and `maximum-scale=1`. Board pinch is unchanged.
