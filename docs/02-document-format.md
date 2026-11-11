# 2. Document format

The on-disk representation of a board. File extension `.mindflow.json`, MIME type
`application/json`, UTF-8, no BOM.

Machine-readable schema: [schema/mindflow-2.0.0.schema.json](schema/mindflow-2.0.0.schema.json).
Reference implementation: [`src/model/document.ts`](../src/model/document.ts).

## Top-level structure

A board holds one or more **workspaces**, each an independent drawing (2.0.0).
The board's identity, name, timestamps and embedded files are shared by all of
them.

```jsonc
{
  "$schema": "https://digster.github.io/mindflow/docs/schema/mindflow-2.0.0.schema.json",
  "type": "mindflow.board",
  "schemaVersion": "2.0.0",
  "id": "brd_7Kq2mXp4Zt",

  "meta": {
    "name": "Checkout redesign",
    "createdAt": "2026-08-14T10:00:00.000Z",
    "updatedAt": "2026-08-14T10:42:11.000Z",
    "app": { "name": "mindflow", "version": "0.1.0" }
  },

  "activeWorkspaceId": "ws_Q7hT2mXp4Z",
  "workspaces": [
    {
      "id": "ws_Q7hT2mXp4Z",
      "name": "User flow",
      "canvas": {
        "background": "#ffffff",
        "grid": { "visible": false, "size": 20, "snap": false }
      },
      "viewport": { "x": 0, "y": 0, "zoom": 1 },
      "elements": [ /* … */ ],
      "meta": {}
    },
    { "id": "ws_b82KdWn3Ya", "name": "Brainstorm", /* … */ }
  ],

  "files": { /* … */ }
}
```

[schema/examples/workspaces.mindflow.json](schema/examples/workspaces.mindflow.json)
is a complete two-workspace board.

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `$schema` | string (URI) | no | Points at the JSON Schema for `schemaVersion`. Writers SHOULD emit it; readers MUST NOT depend on it. |
| `type` | `"mindflow.board"` | **yes** | Format discriminator. A reader MUST reject any other value. |
| `schemaVersion` | string (semver) | **yes** | Version of the *format*, not the app. See [CHANGELOG.md](CHANGELOG.md). |
| `id` | string | **yes** | Board identity. Stable across saves; survives renames. |
| `meta` | object | **yes** | See below. Board-wide: one name and one edit time for every workspace. |
| `activeWorkspaceId` | string | no | The workspace on screen when the board was saved. Readers MAY ignore it. See [Workspaces](#workspaces). |
| `workspaces` | array | **yes** | The drawings. At least one. See [Workspaces](#workspaces). |
| `files` | object | **yes** | Embedded assets, shared by every workspace. May be empty. |

Any other top-level field is not part of this version. A reader that writes
the board back MUST keep it (see [Forward compatibility](#forward-compatibility)).

### `meta`

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name. Not a filename — it may contain characters a filesystem rejects. |
| `createdAt` | string | ISO 8601 UTC with milliseconds. Preserved across saves. |
| `updatedAt` | string | ISO 8601 UTC with milliseconds. When the board's content last changed. Saving does not move it (since 1.6.3; see below). |
| `app.name` | string | Which program wrote the file. Informational only. |
| `app.version` | string | Version of that program. Informational only. |

`app` is **never** used to alter parsing. It exists for debugging ("which build
produced this?"), and a reader that branches on it is doing something wrong.

**`updatedAt` is the time of the last edit, not of the last save.** A writer
moves it when the board's content changes and leaves it alone otherwise.
MindFlow moves it on every edit: adding, changing or deleting an element,
renaming the board, changing the canvas settings, and undo and redo. Moving the
camera, selecting and saving are not edits. A board never edited has
`updatedAt` equal to `createdAt`. MindFlow shows it beside the board name
([05-interactions.md](05-interactions.md#when-the-board-was-last-edited)).

- **Missing or unreadable**, the loader uses `createdAt`: a board that does not
  say it changed is taken not to have. A missing `createdAt` is the time of
  loading, so a file with neither stamp gets one instant for both.
- **Files before 1.6.3** hold the time of their last save here, because a save
  used to stamp it. It is kept as it is ([CHANGELOG](CHANGELOG.md#163--2026-11-07)).
- To know when a file was **written**, use the file system's or the storage
  service's modification time.

### `files`

An object keyed by the **SHA-256 hex digest of the asset's decoded bytes**,
shared by every workspace: an image pasted into two workspaces is stored once.
A file is in use when an element in *any* workspace references it.

```jsonc
"files": {
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08": {
    "mimeType": "image/png",
    "dataUri": "data:image/png;base64,iVBORw0…",
    "byteLength": 20480,
    "createdAt": "2026-08-14T10:20:00.000Z"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `mimeType` | string | e.g. `image/png`. |
| `dataUri` | string | RFC 2397 data URI, including the `data:` prefix. |
| `byteLength` | integer ≥ 0 | Decoded size, so a reader can budget before decoding. |
| `createdAt` | string | ISO 8601 UTC. |

**Why content-addressed?** Deduplication is automatic — the same image pasted ten
times is stored once — and the key is *verifiable*: a reader can confirm that a
`fileId` really identifies its content.

**Fallback keys.** When `crypto.subtle` is unavailable (some non-secure contexts),
MindFlow falls back to a non-cryptographic hash and prefixes the key with `fnv-`.
Such keys are still unique within a document; they are simply not SHA-256. Readers
MUST treat every key as opaque and MUST NOT assume it is a SHA-256 digest.

**Why not inline on the element?** A multi-megabyte base64 string in the middle of
the element array destroys its readability, and the same image referenced twice
would be stored twice.

## Workspaces

A workspace is exactly what a whole board's drawing was in 1.x: a background,
a camera and a flat list of elements. Everything inside one keeps its 1.x
meaning, so every algorithm in [07-rendering.md](07-rendering.md) (routing,
wrapping, anchors, paint order) applies to each workspace on its own.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Unique among the board's workspaces. Opaque, like an element id. MindFlow writes `ws_` + 10 characters, and the workspace upgraded from a 1.x board is `ws_1`. |
| `name` | string | **yes** | Display name. Names may repeat; the id is the identity. MindFlow names a new one `Workspace N` with the lowest free N. |
| `canvas` | object | **yes** | Background and grid of this workspace. See [`canvas`](#canvas). |
| `viewport` | object | **yes** | Camera of this workspace. See [`viewport`](#viewport). |
| `elements` | array | **yes** | The workspace's elements. May be empty. |
| `meta` | object | **yes** | Free-form, for tools other than MindFlow, exactly like an element's [`meta`](#meta-1). |

`workspaces` is in the order MindFlow lists them, which the user can change.

**References stay inside a workspace.** A connector binding, a `frameId` and a
`groupId` resolve among the elements of the workspace that holds them. A
binding that names an element in another workspace is dangling, like one that
names nothing.

**Element ids are unique across the whole board**, not only within a
workspace, so an id names one element of the board wherever it is.

**`activeWorkspaceId`** is a convenience, like `viewport`: it reopens the board
where it was left and carries no meaning. When it is missing, or names no
workspace, the first workspace is the one to show.

**Which drawing is "the board"?** All of them. A reader that can show only one
SHOULD show the active one and say that there are more.

### `canvas`

One per workspace.

| Field | Type | Default | Notes |
|---|---|---|---|
| `background` | CSS colour | `"#ffffff"` | Painted beneath every element. |
| `grid.visible` | boolean | `false` | Whether the grid is drawn. |
| `grid.size` | number > 0 | `20` | Spacing in scene units. |
| `grid.snap` | boolean | `false` | Whether new and moved elements snap to it. |

### `viewport`

One per workspace, so each workspace reopens where it was left.

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `y` | number | `0` | Scene coordinates shown at the canvas's top-left corner. |
| `zoom` | number | `1` | Scale factor. Clamped to `[0.1, 30]` on load. |

The viewport is a convenience so a board reopens where you left it. It carries no
semantic weight: two workspaces differing only in `viewport` are the same drawing.

### Reading the 1.x shape

A board in the 1.x shape (top-level `canvas`, `viewport` and `elements`, no
`workspaces`) is read as a board with one workspace:

- **A 1.x file** is upgraded: its drawing becomes the workspace
  `{"id": "ws_1", "name": "Workspace 1", …}`, which is active. See the
  [CHANGELOG](CHANGELOG.md#200--2026-11-10).
- **A 2.x file in that shape**, as a script that knows the old format might
  write, is read the same way, with an information note. Generating a simple
  board stays as easy as it was.
- **A file with both** a `workspaces` list and non-empty top-level
  `elements` is read without loss: the top-level drawing becomes a last
  workspace, with a warning.

MindFlow always writes the 2.0.0 shape.

## Elements

See [03-elements.md](03-elements.md) for the complete per-type reference. Every
element carries this base:

```jsonc
{
  "id": "el_a1B2c3D4e5",
  "type": "rectangle",
  "x": 100, "y": 200,
  "width": 240, "height": 120,
  "angle": 0,
  "zIndex": 1000,
  "opacity": 1,
  "locked": false,
  "visible": true,
  "groupId": null,
  "style": { "stroke": "#1e1e1e", "strokeWidth": 2, "strokeStyle": "solid",
             "fill": "transparent", "fillStyle": "none", "roughness": 0 },
  "label": null,
  "meta": {}
}
```

### `id`

An opaque string, unique within one document (**not** globally). MindFlow
generates `<prefix>` + 10 characters from a 56-symbol alphabet that excludes
look-alikes (`0`/`O`, `1`/`l`/`I`).

Readers MUST NOT parse an ID, infer order from one, infer type from the prefix, or
assume a prefix is present. `"a"` is a valid ID.

### `zIndex`

Paint order. Higher draws later, therefore on top.

Values are **fractional by design**. MindFlow spaces them 1000 apart, so inserting
between two elements assigns the midpoint and rewrites exactly one number instead
of renumbering everything above. That keeps edits local, which keeps undo entries
and diffs small.

Repeatedly inserting between the same pair halves the gap each time and will
eventually exhaust floating-point precision. MindFlow detects gaps below `0.001`
and renormalises the whole stack back onto clean multiples of 1000. Writers SHOULD
do something equivalent; readers need only sort.

Ties are resolved by array position, but MindFlow never writes ties.

### `groupId`

Grouping is **flat and by reference**. Every element sharing a non-null `groupId`
moves, rotates and deletes as one unit.

There is no group object. A group exists precisely as long as two or more elements
name it. A `groupId` held by exactly one element is *degenerate* — not corrupt, but
always the residue of a bug or a partial edit, and validation reports it.

There is no nesting. A single flat level covers the overwhelming majority of real
use and avoids an entire category of tree-consistency problems.

### `meta`

A free-form object reserved for tools **other than MindFlow**.

MindFlow never reads, writes, interprets or validates its contents, and always
preserves it verbatim across a load/save round trip. Use it to attach your own
annotations without any risk of colliding with a future MindFlow field.

```jsonc
"meta": { "myTool": { "sourceTicket": "PROJ-142", "reviewed": true } }
```

### `style`

| Field | Type | Default | Notes |
|---|---|---|---|
| `stroke` | CSS colour | `"#1e1e1e"` | `"transparent"` means no outline. |
| `strokeWidth` | number ≥ 0 | `2` | Scene units. `0` also means no outline. |
| `strokeStyle` | `solid` \| `dashed` \| `dotted` | `"solid"` | Dash pattern scales with width — see [07-rendering.md](07-rendering.md#dash-patterns). |
| `fill` | CSS colour | `"transparent"` | Ignored entirely when `fillStyle` is `"none"`. |
| `fillStyle` | `solid` \| `none` | `"none"` | |
| `roughness` | number 0–2 | `0` | Hand-drawn jitter. See below. |

`roughness` describes hand-drawn jitter. `0` renders clean geometry; higher values
displace the outline. The field was reserved-but-unwritten in 1.0.0 and is
rendered as of 1.1.0.

The displacement is **fully specified** in
[07-rendering.md](07-rendering.md#hand-drawn-rendering), including the hash and
PRNG, because a partially specified jitter is worse than none: two renderers would
each draw something plausible and disagree. Note that **no seed is stored** — it is
derived from the element's `id`, which is already in the file and already stable.

Readers that cannot reproduce the jitter MUST still accept and preserve the value,
and MAY render the shape as though it were `0`.

Colours: MindFlow writes `#rrggbb`, `#rrggbbaa`, or the exact keyword
`"transparent"`. Readers SHOULD accept any valid CSS colour.

### `label`

Text drawn inside the element, or `null`. It has no coordinates — it is laid out
within the host's box and rotates with it.

| Field | Type | Default |
|---|---|---|
| `text` | string | `""` |
| `fontFamily` | `sans` \| `serif` \| `mono` \| `hand` | `"sans"` |
| `fontSize` | number > 0 | `20` |
| `fontWeight` | integer 100–900 | `400` |
| `lineHeight` | number ≥ 0.5 | `1.25` |
| `color` | CSS colour | `"#1e1e1e"` |
| `textAlign` | `left` \| `center` \| `right` | `"center"` |
| `verticalAlign` | `top` \| `middle` \| `bottom` | `"middle"` |
| `padding` | number ≥ 0 | `8` |

`fontFamily` is a **logical name**, not a typeface. Each maps to a CSS font stack
listed in [07-rendering.md](07-rendering.md#fonts). Storing a logical name keeps
boards portable: a board authored on a machine with different fonts installed
still renders sensibly elsewhere, and the stacks can be improved later without
rewriting existing files.

Line breaking is a computed property — the wrapping algorithm is specified in
[07-rendering.md](07-rendering.md#text-wrapping).

## Invariants

These MUST hold in a valid document. MindFlow checks all of them on load
(`loadDocument` and `validateDocument` in
[`src/model/document.ts`](../src/model/document.ts)); several are also expressible
in the JSON Schema. Invariants 3 to 12 apply to each workspace on its own.

| # | Invariant | Repaired on load? |
|---|---|---|
| 1 | `type` is exactly `"mindflow.board"` | No — the load is rejected |
| 2 | Element `id`s are unique within the board, across every workspace | Yes — duplicates are reassigned. Within one workspace, references are left alone, since it cannot be told which element they meant. A later workspace reusing an earlier one's ids gets new ids, and the bindings and frame references inside it follow them, so a workspace copied in a text editor loads as an independent drawing. |
| 3 | `width > 0` and `height > 0` | Yes — clamped to ≥ 1 |
| 4 | `angle` is in `[0, 360)` | Yes — normalised |
| 5 | `opacity` is in `[0, 1]` | Yes — clamped |
| 6 | `zIndex` is finite | Yes — assigned from array position |
| 7 | Connector `points` has ≥ 2 entries | Yes — a degenerate pair is synthesised |
| 8 | Every binding's `elementId` exists in the same workspace | No — reported |
| 9 | No connector binds to itself | No — reported |
| 10 | Every `image.fileId` resolves in `files` | No — reported, renders as a placeholder |
| 11 | Every `groupId` is shared by ≥ 2 elements | No — reported |
| 12 | Elements are sorted ascending by `zIndex` | Yes — sorted |
| 13 | A board has at least one workspace | Yes — an empty one is created |
| 14 | Workspace `id`s are unique | Yes — duplicates are reassigned |
| 15 | `activeWorkspaceId`, when present, names a workspace | Yes — the first workspace is shown, with a warning |
| 16 | Every `frameId` names a frame in the same workspace | Yes — the containment is dropped, with a warning |

**Reading is lenient; writing is strict.** The loader coerces what it can, fills
defaults for what is missing, records a warning for anything it changed, and
rejects only what is genuinely unreadable. The writer always emits fully-populated
canonical output. That asymmetry is what makes the format practical to *generate*
from a script or a language model while keeping the files MindFlow itself produces
perfectly consistent.

Numeric strings are accepted where a number is expected (`"x": "100"` → `100`), and
points may be written as `{"x": 1, "y": 2}` objects on input even though tuples are
always written out.

## Canonical output

When MindFlow writes a file:

- Keys appear in the order shown at the top of this document — fixed, not left to
  object-literal chance — so two saves of the same board are byte-identical.
- JSON is pretty-printed with **two-space indentation** and a trailing newline.
- Coordinates are rounded to **2 decimal places**; angles and opacity to 3; zoom
  to 4.
- Workspaces are written in list order, and each workspace's `elements`
  ascending by `zIndex`.
- `$schema` and `schemaVersion` name the current version, whatever version the
  board was read in: the file is written in this version's shape.
- Fields this version does not know, on the board or on a workspace, are
  written back verbatim after the known ones.
- `meta.createdAt` and `meta.updatedAt` are written as the board holds them.
  Saving is not an edit, so it moves neither ([`meta`](#meta)). Before 1.6.3,
  a save set `updatedAt` to now, which also made every save differ from the
  last.

**Why pretty-printed?** It costs roughly 30% file size against minified JSON and
buys readable `git diff`s, the ability to inspect or hand-edit a board in any text
editor, and substantially better results when a language model reads the file. For
a format whose stated purpose is external interpretability, that is an easy trade.

**Why rounded?** Without it, dragging a shape one pixel and back leaves
`"x": 100.00000000000001` and a noisy diff. Two decimals is far finer than any
display resolves at sane zoom levels, and it makes a save/load/save cycle
byte-stable — which the round-trip test relies on.

## Forward compatibility

A reader that encounters an element whose `type` it does not recognise MUST NOT
delete it. MindFlow holds such elements aside verbatim and writes them back, in
z-order, into the same workspace, on the next save.

The same goes for **fields** (2.0.0): a top-level or workspace field a reader
does not know MUST be kept and written back. MindFlow holds them aside and
writes them after the fields it knows. This is what lets a later minor version
add a board or workspace field: an older reader keeps it instead of dropping
it. (1.x readers dropped unknown top-level fields, which is one reason 2.0.0
had to be a major version.)

This matters: opening a board that uses a newer element type in an older build,
then saving, must not silently destroy that element. See
[06-persistence.md](06-persistence.md#unknown-element-types).
