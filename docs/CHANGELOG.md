# Schema changelog

Version history of the **`.mindflow.json` format**. This is separate from the
application's version — the app in `package.json` may release many times without
the format changing at all.

## Versioning rules

The format follows semantic versioning, interpreted for a data format:

| Change | Bump | Example |
|---|---|---|
| **Major** | Old readers cannot correctly interpret new files | Renaming or removing a field; changing a field's meaning |
| **Minor** | Additive; old readers degrade gracefully | Adding an element type; adding an optional field |
| **Patch** | No structural change | Clarifying documentation; tightening a constraint that was already implied |

Two rules are absolute:

1. **Published schemas are immutable.** Saved files reference a schema by URL. To
   change the format, add `mindflow-<new>.schema.json` — never edit a released
   one.
2. **Every breaking change ships with a migration**, in `src/model/migrate.ts`,
   plus a fixture proving an old file still loads.

## Reader expectations

A reader encountering a version it does not know should:

- **Older major** → apply migrations, or refuse with a clear message.
- **Newer minor/patch** → load it. The format is additive within a major version;
  preserve anything unrecognised (see
  [06-persistence.md](06-persistence.md#unknown-element-types)) rather than
  dropping it.
- **Newer major** → warn, attempt the load, and preserve what it cannot interpret.

---

## 1.0.0 — 2026-08-14

Initial published format.

### Element types

`rectangle`, `ellipse`, `line`, `arrow`, `draw`, `text`, `sticky`, `image`.

### Notable design decisions

These are recorded here because the *reasons* matter as much as the shapes, and
they constrain what future versions can do.

**Flat element array, not a tree.** Grouping and connector bindings are ID
references. Keeps the array sortable, sliceable and diffable, and removes any
ambiguity about relative versus absolute transforms.

**No style inheritance.** Every element carries its complete resolved style, so a
single element is interpretable in isolation. Costs repetition; buys the ability
to reason about any element without reading the rest of the document.

**Degrees, not radians.** `"angle": 45` is legible to a human or a language model
reading raw JSON; `0.7853981633974483` is not.

**Fractional `zIndex`.** Inserting between two elements rewrites one number
instead of renumbering the stack, keeping undo entries and diffs small.

**`sticky` is its own type**, not a rectangle carrying a label. The two would
render almost identically, but a distinct type preserves authorial intent — a
program can answer "what are the sticky notes here?" from the data rather than
from styling heuristics.

**Point tuples, not objects.** `[x, y]` rather than `{"x":…,"y":…}`. A freehand
stroke holds hundreds of points, and the object form roughly triples file size
while making the JSON far harder to skim. Same reasoning as GeoJSON.

**Content-addressed `files` map.** Images are stored once regardless of how many
elements reference them, keyed by a hash of their bytes, and kept out of the
element array so it stays readable.

**`style.roughness` reserved but unimplemented.** Always written as `0` in 1.0.0.
Adding a field later is a breaking change for strict readers; reserving one now
costs nothing. Readers must accept and preserve non-zero values.

**`meta` reserved for third parties.** MindFlow never reads or validates it and
always preserves it, so external tools can annotate elements without a schema
change or a fork.

**Pretty-printed output.** Roughly 30% larger than minified, and worth it for
readable diffs, hand-editability, and language-model comprehension.

### Known limitations

Recorded so they are not rediscovered as surprises.

- **No nested groups.** One flat level of grouping.
- **No per-element affine transform.** Only position, size and rotation are
  stored, so a group resize cannot shear rotated members — it approximates. See
  [04-coordinates.md](04-coordinates.md#multi-element-resize).
- **Auto-anchored connectors store a cached route.** The stored `points` reflect
  the last computation; a reader that moves a bound element must re-route. See
  [07-rendering.md](07-rendering.md#binding-resolution).
- **Text layout depends on font metrics.** A renderer without the same fonts will
  break lines differently. The stored `width`/`height` are always correct, so a
  reader that cannot measure text should trust them.
- **`files` entries are not garbage-collected mid-session.** An image whose
  element is deleted stays embedded until the next explicit save-as. Validation
  reports unreferenced files as `info`.

---

## 1.1.0 — 2026-08-16

Additive. Every 1.0.0 file remains valid, and a 1.0.0 reader can load a 1.1.0
file, degrading only on what it does not recognise.

### Added

**`diamond` element type.** A rhombus for flowchart decision nodes, carrying no
fields of its own — the four vertices are the midpoints of the box's edges, so
the box is the entire geometry. Full reference in
[03-elements.md](03-elements.md#diamond).

It was chosen as the first new type deliberately: it is the smallest possible
complete addition, which makes it the honest test of whether the extension path
in [09-extending.md](09-extending.md) actually works. It did not, quite — see
below.

### Changed

**`style.roughness` is now rendered rather than reserved.** The field has existed
since 1.0.0, always written as `0`. It now drives a hand-drawn look, specified in
[07-rendering.md](07-rendering.md#hand-drawn-rendering).

The interesting decision is the seed. Jitter needs one, or the same file draws
differently on every open — and if the seed were unspecified, two renderers would
disagree about a file that validates perfectly, which is exactly the failure this
format exists to prevent. Storing a `seed` field was the obvious option and was
rejected: it is a structural change to every element for a value that can be
derived. **The seed is the element's `id`**, hashed as specified in
07-rendering.md. Ids are already stored, already stable across a save/load round
trip, and already re-minted on duplicate — so a copy legitimately gets its own
squiggle, which is the behaviour you want anyway.

Consequently there is no schema change for roughness at all: `0..2` was already
the constraint, and only the field's *description* differs from 1.0.0.

**Auto-anchor resolution is now specified per shape**, with the rectangular
outline as the documented default rather than an implicit else-branch. See
[07-rendering.md](07-rendering.md#binding-resolution). A reader that meets an
unknown type should use the rectangular default.

### Notes for implementers

Two things this release exposed about the format's own tooling, recorded because
they will apply to the next type too:

- **A new type must appear in `$defs.element.oneOf`**, not merely as a `$defs`
  entry with its name added to the `baseElement` type enum. The union is what a
  validator actually walks.
- **The `$schema` URL every saved file carries is derived from the version
  constant**, so it can no longer drift from it. It was previously a hand-written
  literal that no test checked.

---

## 1.3.0 — 2026-08-20

Additive. A 1.2.0 file is a valid 1.3.0 file with no tables.

### Added

**`table` element type** — a grid of text cells. Full reference in
[03-elements.md](03-elements.md#table); the layout algorithm is specified in
[07-rendering.md](07-rendering.md#tables).

The design decisions, since each rules out something that looks more obvious:

**`columns` and `rows` hold proportions, not lengths.** A track's rendered size is
`track / Σ tracks × boxDimension`. Absolute lengths were the obvious choice and
are wrong for this format: they create a second description of how big the table
is, which then has to be kept in step with `width`/`height` on every resize —
meaning a type-specific resize rule in every writer, and a file format with an
invariant that can silently break. Proportions make resizing a table the same
base-geometry change every other element gets, and there is no state in which the
tracks and the box disagree. The cost is one multiplication in every reader.

**Cells are plain strings in a row-major array.** `[["Name","Qty"],["Apples","3"]]`
is the shape that makes a table worth having in a format meant to be read and
generated outside its application. Making a cell an object so it could carry
per-cell styling would tax every cell for a field almost none of them use, and
`meta` already exists for a tool that needs one.

**Typography is one set of fields on the element**, shared by every cell, for the
same reason nothing else in this format inherits: a value that varies per cell has
to be stored per cell, and none of these do.

**Merged cells are not modelled.** A span puts a second geometry on top of the
track grid, and every consumer — layout, hit-testing, export, a script reading the
board — would have to resolve it before reading a single cell. A table whose cells
are exactly the intersections of its tracks is interpretable with one loop.

**One header axis, not two.** `headerRow` tints the first row and draws it at
`max(fontWeight, 600)`. A header *column* would double the rendering rules for the
minority of tables that want one.

### Notes for implementers

`cells` is declared as exactly `rows.length × columns.length`, and writers MUST
emit that shape — but readers SHOULD pad and truncate rather than reject, so that
`cells[row][column]` needs no bounds check. MindFlow also stringifies a numeric or
boolean cell and infers a missing `columns`/`rows` from the shape of `cells`,
which makes a table practical to emit from a script with three lines of code.

A 1.2.0 reader meeting a `table` will not recognise the type and should preserve
it verbatim (see
[06-persistence.md](06-persistence.md#unknown-element-types)) rather than drop it.

---

## 1.2.0 — 2026-08-16

Additive. A 1.1.0 file is a valid 1.2.0 file with no frames.

### Added

**`frame` element type**, and **`frameId` on every element**. A frame is a named
region that clips and moves its contents. Full reference in
[03-elements.md](03-elements.md#frame).

The design decisions, since each rules out something that looks more obvious:

**Containment is an ID reference held by the child**, mirroring `groupId`, rather
than a `childIds` list on the frame or an actual tree. The flat array is the thing
this format keeps defending — sortable, sliceable, diffable, with no ambiguity
about relative versus absolute transforms — and a parent-pointer preserves all of
it. A framed element's `x`/`y` remain ordinary scene coordinates.

**Frames do not nest.** A frame's own `frameId` is always `null`. Nesting would
reintroduce the tree by the back door, along with questions about how a clip
composes with an ancestor's clip, for a use case that has not appeared.

**Membership is decided by the element's centre**, not by overlap. An element
straddling a border needs exactly one answer, and the centre gives one without a
tie-break rule.

**Frames are never rotated.** `rotatable` is false and `angle` is always `0`,
which is what keeps the clip region a plain rectangle in every renderer rather
than a rotated polygon that each would have to intersect for itself.

**The interior is click-through.** A frame that swallowed clicks would make its
own contents unselectable. It is grabbed by its border, exactly like an unfilled
rectangle — no new concept.

### Notes for implementers

`frameId` is `required` in the schema, as `groupId` already was. A 1.1.0 reader
meeting it should ignore and preserve it, which degrades to "frames do not clip"
rather than to breakage.

---

## Unreleased

Candidates under consideration, in rough priority order:

- Google Picker support, to lift the `drive.file` limitation described in
  [08-google-drive.md](08-google-drive.md#the-limitation-stated-plainly).
- Nested groups — only if a real use case appears. The flat model has not been
  the constraint it was expected to be.
