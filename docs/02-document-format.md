# 2. Document format

The on-disk representation of a board. File extension `.mindflow.json`, MIME type
`application/json`, UTF-8, no BOM.

Machine-readable schema: [schema/mindflow-1.0.0.schema.json](schema/mindflow-1.0.0.schema.json).
Reference implementation: [`src/model/document.ts`](../src/model/document.ts).

## Top-level structure

```jsonc
{
  "$schema": "https://digster.github.io/mindflow/docs/schema/mindflow-1.0.0.schema.json",
  "type": "mindflow.board",
  "schemaVersion": "1.0.0",
  "id": "brd_7Kq2mXp4Zt",

  "meta": {
    "name": "Untitled board",
    "createdAt": "2026-08-14T10:00:00.000Z",
    "updatedAt": "2026-08-14T10:42:11.000Z",
    "app": { "name": "mindflow", "version": "0.1.0" }
  },

  "canvas": {
    "background": "#ffffff",
    "grid": { "visible": false, "size": 20, "snap": false }
  },

  "viewport": { "x": 0, "y": 0, "zoom": 1 },

  "elements": [ /* … */ ],

  "files": { /* … */ }
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `$schema` | string (URI) | no | Points at the JSON Schema for `schemaVersion`. Writers SHOULD emit it; readers MUST NOT depend on it. |
| `type` | `"mindflow.board"` | **yes** | Format discriminator. A reader MUST reject any other value. |
| `schemaVersion` | string (semver) | **yes** | Version of the *format*, not the app. See [CHANGELOG.md](CHANGELOG.md). |
| `id` | string | **yes** | Board identity. Stable across saves; survives renames. |
| `meta` | object | **yes** | See below. |
| `canvas` | object | **yes** | Background and grid. |
| `viewport` | object | **yes** | Saved camera position. Readers MAY ignore it entirely. |
| `elements` | array | **yes** | The board. May be empty. |
| `files` | object | **yes** | Embedded assets. May be empty. |

### `meta`

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name. Not a filename — it may contain characters a filesystem rejects. |
| `createdAt` | string | ISO 8601 UTC with milliseconds. Preserved across saves. |
| `updatedAt` | string | ISO 8601 UTC. Rewritten on every save. |
| `app.name` | string | Which program wrote the file. Informational only. |
| `app.version` | string | Version of that program. Informational only. |

`app` is **never** used to alter parsing. It exists for debugging ("which build
produced this?"), and a reader that branches on it is doing something wrong.

### `canvas`

| Field | Type | Default | Notes |
|---|---|---|---|
| `background` | CSS colour | `"#ffffff"` | Painted beneath every element. |
| `grid.visible` | boolean | `false` | Whether the grid is drawn. |
| `grid.size` | number > 0 | `20` | Spacing in scene units. |
| `grid.snap` | boolean | `false` | Whether new and moved elements snap to it. |

### `viewport`

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `y` | number | `0` | Scene coordinates shown at the canvas's top-left corner. |
| `zoom` | number | `1` | Scale factor. Clamped to `[0.1, 30]` on load. |

The viewport is a convenience so a board reopens where you left it. It carries no
semantic weight: two boards differing only in `viewport` are the same drawing.

### `files`

An object keyed by the **SHA-256 hex digest of the asset's decoded bytes**.

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
(`validateDocument` in [`src/model/document.ts`](../src/model/document.ts)); several
are also expressible in the JSON Schema.

| # | Invariant | Repaired on load? |
|---|---|---|
| 1 | `type` is exactly `"mindflow.board"` | No — the load is rejected |
| 2 | Element `id`s are unique within the document | Yes — duplicates are reassigned |
| 3 | `width > 0` and `height > 0` | Yes — clamped to ≥ 1 |
| 4 | `angle` is in `[0, 360)` | Yes — normalised |
| 5 | `opacity` is in `[0, 1]` | Yes — clamped |
| 6 | `zIndex` is finite | Yes — assigned from array position |
| 7 | Connector `points` has ≥ 2 entries | Yes — a degenerate pair is synthesised |
| 8 | Every binding's `elementId` exists in the document | No — reported |
| 9 | No connector binds to itself | No — reported |
| 10 | Every `image.fileId` resolves in `files` | No — reported, renders as a placeholder |
| 11 | Every `groupId` is shared by ≥ 2 elements | No — reported |
| 12 | Elements are sorted ascending by `zIndex` | Yes — sorted |

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
- `elements` is sorted ascending by `zIndex`.
- `meta.updatedAt` is set to now; `meta.createdAt` is preserved.

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
z-order, on the next save.

This matters: opening a board that uses a newer element type in an older build,
then saving, must not silently destroy that element. See
[06-persistence.md](06-persistence.md#unknown-element-types).
