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
