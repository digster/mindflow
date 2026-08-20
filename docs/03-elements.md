# 3. Element reference

Every element type, every field, every default.

All elements carry the base fields documented in
[02-document-format.md](02-document-format.md#elements) — `id`, `type`, `x`, `y`,
`width`, `height`, `angle`, `zIndex`, `opacity`, `locked`, `visible`, `groupId`,
`style`, `label`, `meta`. This page covers only what each type **adds**, plus its
type-specific behaviour.

> **Contract note.** Every `## ` heading below corresponds to exactly one type
> registered in [`src/model/registry.ts`](../src/model/registry.ts), and
> `test/unit/contract.test.ts` fails the build if that correspondence breaks.

## Capability matrix

Capabilities are declared per type in the registry and drive the UI — which
controls the style panel shows, whether double-click opens a text editor, whether
a connector can attach.

| Type | `label` | `path` | `text` | `resizable` | `rotatable` | `bindable` |
|---|---|---|---|---|---|---|
| `rectangle` | ✓ | | | ✓ | ✓ | ✓ |
| `ellipse` | ✓ | | | ✓ | ✓ | ✓ |
| `diamond` | ✓ | | | ✓ | ✓ | ✓ |
| `frame` | | | | ✓ | | ✓ |
| `line` | ✓ | ✓ | | ✓ | ✓ | |
| `arrow` | ✓ | ✓ | | ✓ | ✓ | |
| `draw` | | ✓ | | ✓ | ✓ | |
| `text` | | | ✓ | ✓ | ✓ | ✓ |
| `sticky` | | | ✓ | ✓ | ✓ | ✓ |
| `table` | | | ✓ | ✓ | ✓ | ✓ |
| `image` | ✓ | | | ✓ | ✓ | ✓ |

- **`label`** — can carry text inside it via the `label` object.
- **`path`** — geometry is a `points` list rather than a plain box.
- **`text`** — owns its text directly rather than through `label`, and it is
  editable in place. Usually that means one `text` field; a `table` instead owns
  one block per cell, addressed individually (see [`table`](#table)).
- **`bindable`** — a connector endpoint can attach to it.

Connectors are deliberately **not** bindable. Binding arrows to arrows creates
dependency chains with no stable layout fixed point.

---

## rectangle

A rounded box.

| Field | Type | Default | Notes |
|---|---|---|---|
| `cornerRadius` | number ≥ 0 | `8` | Scene units. |

`cornerRadius` is **clamped at render time** to half the shorter side, so an
arbitrarily large value produces a stadium shape rather than invalid geometry. The
stored value is never clamped — a box resized smaller and back keeps its radius.

**Hit-testing:** a filled rectangle (or one carrying non-empty label text) is hit
anywhere inside. An unfilled one is hit only near its outline, so you can click
*through* the hollow middle to reach whatever is behind. This is standard drawing
tool behaviour and is the single most important detail in making selection feel
right.

```jsonc
{
  "id": "el_q2WikW58Aw", "type": "rectangle",
  "x": 60, "y": 90, "width": 140, "height": 70,
  "angle": 0, "zIndex": 1000, "opacity": 1,
  "locked": false, "visible": true, "groupId": null,
  "style": { "stroke": "#1e1e1e", "strokeWidth": 2, "strokeStyle": "solid",
             "fill": "#a5d8ff", "fillStyle": "solid", "roughness": 0 },
  "label": null, "meta": {},
  "cornerRadius": 8
}
```

---

## ellipse

An ellipse inscribed in the element's box. A square box yields a circle.

Adds no fields.

**Hit-testing:** filled — anywhere inside the ellipse (not the box). Unfilled —
within tolerance of the outline.

---

## diamond

A rhombus, for flowchart decision nodes.

Adds no fields.

**Geometry:** the four vertices are the midpoints of the box's edges — in local
coordinates, clockwise from the top: `(w/2, 0)`, `(w, h/2)`, `(w/2, h)`,
`(0, h/2)`. The box is the entire geometry, so a diamond is fully described by
`x`, `y`, `width`, `height` and `angle`.

**Hit-testing:** as for every closed shape — a filled diamond (or one carrying
non-empty label text) is hit anywhere inside its outline, and an unfilled one only
near its edges, so a click passes through the hollow middle.

**Connector anchoring:** an `auto`-bound connector attaches to the *rhombus*, not
its bounding box. Substituting a ray `(t·dx, t·dy)` into `|x|/a + |y|/b = 1`,
where `a = width/2` and `b = height/2`, gives the crossing directly:

```
t = 1 / (|dx|/a + |dy|/b)
```

Falling back to the rectangular default would leave an arrow aimed near a corner
stopping up to `min(width, height) / 2` short of the visible edge. See
[07-rendering.md](07-rendering.md#binding-resolution).

---

## frame

A named region that clips and moves its contents.

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | `"Frame"` | Drawn above the top-left corner. May be empty. |

**Containment is by reference from the child.** An element inside a frame carries
`"frameId": "<the frame's id>"`; the frame holds no list of its own. This mirrors
`groupId` and keeps the element array flat, sortable and diffable.

**Coordinates stay absolute.** A framed element's `x`/`y` are ordinary scene
coordinates, *not* relative to its frame. Nothing about containment changes how
geometry is read.

**Frames do not nest.** A `frame`'s own `frameId` is always `null`. Readers should
enforce this rather than trust it — MindFlow does, on load.

**Never rotated.** `angle` is always `0`, and `rotatable` is false. This is what
keeps the clip region a plain rectangle instead of a rotated polygon, in every
renderer.

**Rendering:** the frame is painted as an ordinary filled and stroked rectangle,
in `zIndex` order like anything else — put it *below* its contents by giving it a
lower `zIndex`. Every element with a matching `frameId` is then clipped to the
frame's box. The `name` is drawn outside the box, left-aligned to the frame's left
edge with its baseline 6 scene units above the top edge, in 13px semibold `sans`.

**Membership:** an element belongs to the topmost frame whose box contains the
element's **centre**. Centre containment, not overlap, so an element straddling a
border has exactly one unambiguous answer. MindFlow recomputes this whenever an
element is dropped; see [05-interactions.md](05-interactions.md#frames).

**Moving and deleting:** moving a frame moves its members by the same delta.
Deleting a frame deletes its members. Resizing a frame does **not** resize its
members — it re-clips them.

**Hit-testing:** the interior is click-through, so contents stay reachable. The
frame is hit only near its border, within the usual tolerance. Its `name` is
decorative and is not part of the hit region.

**Dangling references:** a `frameId` naming an element that is absent or is not a
frame should be treated as `null`. A reader that clips to a missing frame would
render the element invisibly with no explanation.

---

## line

A polyline without arrowheads by default. Shares its implementation with
[`arrow`](#arrow); see that section for the full field list.

The only difference is defaults: a `line` is created with both arrowheads set to
`"none"`.

A `line` and an `arrow` with identical fields render identically. The type records
what the author *meant*; the arrowhead fields record what is drawn.

---

## arrow

A polyline with arrowheads and connector bindings. This is the type that makes
MindFlow a flow-diagramming tool rather than a drawing program.

| Field | Type | Default | Notes |
|---|---|---|---|
| `points` | array of tuples | — | ≥ 2 vertices, **relative to `x`/`y`**. |
| `startArrowhead` | see below | `"none"` | |
| `endArrowhead` | see below | `"arrow"` (`"none"` for `line`) | |
| `curve` | `straight` \| `curved` \| `elbow` | `"straight"` | |
| `startBinding` | Binding \| null | `null` | |
| `endBinding` | Binding \| null | `null` | |

**Arrowheads:** `none`, `arrow`, `triangle`, `dot`, `bar`.

### `points`

Vertices are **relative to the element's `x`/`y`**, so translating the element
never touches this array. Each is a two- or three-element tuple `[x, y]` or
`[x, y, pressure]`; the third component is ignored for connectors.

Tuples rather than `{x, y}` objects: a long path would otherwise triple in size
and become unreadable. This follows GeoJSON's reasoning.

The first and last points are the endpoints that bindings apply to.

### Bindings

```jsonc
"endBinding": {
  "elementId": "el_R4NLqX9ZB3",
  "anchor": { "mode": "auto" },
  "gap": 4
}
```

| Field | Type | Notes |
|---|---|---|
| `elementId` | string | MUST reference an existing, `bindable` element. |
| `anchor` | object | `{"mode": "auto"}` or `{"mode": "fixed", "u": …, "v": …}`. |
| `gap` | number ≥ 0 | Clearance between the target's outline and the tip, in scene units. |

- **`auto`** — the attachment point is recomputed whenever either element moves,
  by casting a ray from the target's centre toward the connector's other end and
  taking where it crosses the outline. Attaches to whichever edge faces the other
  end.
- **`fixed`** — pinned to a specific spot, given in normalised coordinates on the
  target's local unrotated box: `u` runs 0 (left) → 1 (right), `v` runs 0 (top) →
  1 (bottom). The point is transformed by the target's rotation, so it follows the
  shape as it turns.

> **The stored `points` of a bound connector are a cache, not the truth.** They
> reflect the last computed route. A reader that moves a bound element MUST
> recompute them using the algorithm in
> [07-rendering.md](07-rendering.md#binding-resolution), or the arrow will detach
> visually from its target.

---

## draw

A freehand stroke.

| Field | Type | Default | Notes |
|---|---|---|---|
| `points` | array of tuples | — | ≥ 1 vertex, relative to `x`/`y`. |
| `pressureSensitive` | boolean | `false` | |

When `pressureSensitive` is true, the third tuple component is stylus pressure in
`[0, 1]` and the stroke is rendered with a variable width mapped to
`0.4×`–`1.4×` of `strokeWidth`. When false, any pressure values present are
ignored for rendering but still preserved on save.

MindFlow sets it true only for `pointerType === "pen"`. A mouse reports a constant
pressure of 0.5, which would produce a uniformly thin stroke if treated as real.

**Simplification.** Captured points are thinned with Douglas–Peucker (tolerance
0.8 scene units) once, on commit — not during the stroke, so live feedback stays
exact and only the stored result is reduced. A two-second stroke typically drops
from several hundred points to a few dozen.

`draw` elements ignore `strokeStyle`: freehand ink is never dashed.

---

## text

Free-standing text. Distinct from a `label`, which is text inside another element.

| Field | Type | Default |
|---|---|---|
| `text` | string | `""` |
| `fontFamily` | `sans` \| `serif` \| `mono` \| `hand` | `"sans"` |
| `fontSize` | number > 0 | `20` |
| `fontWeight` | integer 100–900 | `400` |
| `lineHeight` | number ≥ 0.5 | `1.25` |
| `color` | CSS colour | `"#1e1e1e"` |
| `textAlign` | `left` \| `center` \| `right` | `"left"` |
| `verticalAlign` | `top` \| `middle` \| `bottom` | `"top"` |
| `autoWidth` | boolean | `true` |

`style.stroke` and `style.fill` are unused — text draws with its own `color`.
MindFlow writes them as `"transparent"`.

### `autoWidth`

- **`true`** — `width` is derived from the text and recomputed on every edit; the
  text never wraps on its own.
- **`false`** — `width` is authoritative and the text wraps to fit it.

Either way, `width` and `height` are always written out correctly. **A reader that
cannot measure text should trust the stored dimensions and ignore this flag.**

---

## sticky

A sticky note: a filled rounded box with text inside.

| Field | Type | Default |
|---|---|---|
| `text` | string | `""` |
| `fontFamily` | `sans` \| `serif` \| `mono` \| `hand` | `"sans"` |
| `fontSize` | number > 0 | `16` |
| `fontWeight` | integer 100–900 | `400` |
| `lineHeight` | number ≥ 0.5 | `1.25` |
| `color` | CSS colour | `"#1e1e1e"` |
| `textAlign` | `left` \| `center` \| `right` | `"left"` |
| `verticalAlign` | `top` \| `middle` \| `bottom` | `"top"` |
| `padding` | number ≥ 0 | `12` |

Default size when created by a click rather than a drag: 160 × 160.
Default fill: `#ffec99`. Default stroke: `"transparent"` with width `0` — the
inverse of every other shape's default, because a note should read as paper rather
than as an outlined box.

**Why its own type and not a rectangle with a label?** The two would render almost
identically, but a distinct type preserves the author's intent in the file. A
program reading a board can answer *"what are the sticky notes here?"* from the
data, rather than guessing from styling heuristics. That semantic legibility is
worth one extra type — and it is exactly the kind of thing this format exists to
make possible.

**Rendering:** a soft drop shadow is drawn when the note has no stroke, which is
what sells "piece of paper". Text is clipped to the note, so an overfull note
looks full rather than spilling words across the canvas.

---

## table

A grid of text cells.

| Field | Type | Default | Notes |
|---|---|---|---|
| `columns` | number[] , ≥1 entry, all > 0 | `[1, 1, 1]` | **Relative** column widths, left to right. |
| `rows` | number[] , ≥1 entry, all > 0 | `[1, 1, 1]` | **Relative** row heights, top to bottom. |
| `cells` | string[][] | all `""` | Row-major: `cells[row][column]`. |
| `headerRow` | boolean | `true` on create, `false` when omitted from a file | First row is tinted and drawn heavier. |
| `headerFill` | CSS colour | `"#f1f3f5"` | Header background. Ignored when `headerRow` is false. |
| `fontFamily` | `sans` \| `serif` \| `mono` \| `hand` | `"sans"` | |
| `fontSize` | number > 0 | `14` | |
| `fontWeight` | integer 100–900 | `400` | |
| `lineHeight` | number ≥ 0.5 | `1.25` | |
| `color` | CSS colour | `"#1e1e1e"` | |
| `textAlign` | `left` \| `center` \| `right` | `"left"` | |
| `verticalAlign` | `top` \| `middle` \| `bottom` | `"middle"` | |
| `padding` | number ≥ 0 | `8` | Inset between a cell's box and its text. |

Default size when created by a click rather than a drag: 360 × 120 (three
120-wide columns, three 40-high rows). Default style: `#adb5bd` hairline stroke
at width 1 over a solid `#ffffff` fill — a table reads as a document rather than
as a drawing, and 2px rules would overwhelm 14px text.

### `columns` and `rows` are proportions, not lengths

This is the one thing about a table that a reader must not guess. A track's
rendered size is

```
size[i] = tracks[i] / Σ tracks × boxDimension
```

where `boxDimension` is the element's `width` for columns and `height` for rows.
The full layout, including cell boxes and text placement, is specified in
[07-rendering.md](07-rendering.md#tables).

**Why proportions?** Because `width` and `height` are then the only description
of how much room the table occupies, exactly as for every other type. Resizing a
table is the ordinary base-geometry change, with no track rewriting, and there is
no state in which the tracks and the box disagree. The cost is one multiplication
in every reader; the alternative costs a type-specific resize rule in every
*writer*.

MindFlow writes equal tracks as `1`s, so `"columns": [2, 1, 1]` says *"the first
column is twice as wide as the others"* directly. Absolute scene units are
equally valid input — `[240, 120, 120]` renders identically — but they are not
what MindFlow emits and a reader must not treat any track value as a length.

### `cells`

`cells` has exactly `rows.length` entries, each with exactly `columns.length`
strings. A writer MUST emit that shape. A reader SHOULD repair rather than reject:
pad short rows with `""` and truncate long ones, which is what MindFlow does, so
that `cells[row][column]` never needs a bounds check.

MindFlow's loader is lenient in one further way worth knowing about, because it
makes tables practical to generate: a cell holding a **number or a boolean** is
stringified rather than blanked, and a table with `cells` but no `columns`/`rows`
gets its shape inferred from the grid (row count from `cells.length`, column count
from the widest row).

**Merged cells are deliberately not modelled.** Spans would put a second,
overlapping geometry on top of the track grid, and every consumer — layout,
hit-testing, export — would need to resolve it before it could read a single
cell. A table whose cells are exactly the intersections of its tracks can be
interpreted with one loop. A tool that needs spans can record them under `meta`.

Per-cell styling is out of scope for the same reason: it would force every cell
to become an object to carry fields that almost no cell uses, and
`[["Name","Qty"],["Apples","3"]]` is the shape that makes a table worth having in
this format.

### Header row

When `headerRow` is true the **first** row only is filled with `headerFill`,
painted over the element's own fill, and its text is drawn at
`max(fontWeight, 600)` — at least semibold, and heavier still if the table itself
is already bold. There is no header *column*: one axis covers the overwhelming
majority of tables, and the second would double the rendering rules for the rest.

### Rendering summary

Painted in this order, all clipped to the element's box:

1. The element's fill, if any, across the whole box.
2. The header band, if `headerRow`.
3. Each cell's text, wrapped to `cellWidth − padding × 2` and clipped to its cell.
4. Interior rules and the outer border, in the element's stroke style.

**Hit-testing:** solid. A table is a content container like a sticky note or an
image, and clicking an empty cell to type in it has to work whether or not the
table has a fill.

**Connector anchoring:** the default rectangular outline, since the table's
outline *is* its box.

```jsonc
{
  "id": "el_ReleasePlan", "type": "table",
  "x": 80, "y": 80, "width": 480, "height": 160,
  "angle": 0, "zIndex": 1000, "opacity": 1,
  "locked": false, "visible": true, "groupId": null, "frameId": null,
  "style": { "stroke": "#adb5bd", "strokeWidth": 1, "strokeStyle": "solid",
             "fill": "#ffffff", "fillStyle": "solid", "roughness": 0 },
  "label": null, "meta": {},
  "columns": [2, 1, 1],
  "rows": [1, 1, 1, 1],
  "cells": [
    ["Milestone", "Owner", "Due"],
    ["Schema 1.3.0 published", "Ana", "12 Sep"],
    ["Importer updated", "Bo", "19 Sep"],
    ["Docs reviewed", "Cai", "26 Sep"]
  ],
  "headerRow": true, "headerFill": "#f1f3f5",
  "fontFamily": "sans", "fontSize": 14, "fontWeight": 400, "lineHeight": 1.25,
  "color": "#1e1e1e", "textAlign": "left", "verticalAlign": "middle", "padding": 8
}
```

---

## image

An embedded bitmap or SVG.

| Field | Type | Default | Notes |
|---|---|---|---|
| `fileId` | string | — | Key into the document's `files` map. MUST resolve. |
| `naturalWidth` | number > 0 | — | Intrinsic pixel width of the source. |
| `naturalHeight` | number > 0 | — | Intrinsic pixel height. |
| `objectFit` | `fill` \| `contain` \| `cover` | `"fill"` | As per CSS `object-fit`. |

- **`fill`** — stretch to the box, ignoring aspect ratio.
- **`contain`** — scale to fit entirely inside, letterboxing the remainder.
- **`cover`** — scale to fill the box, cropping the overflow symmetrically.

Rendering is always clipped to the element's box, so `cover` never paints outside
its declared bounds — which culling and hit-testing both rely on.

**Import limits.** MindFlow rejects sources over 12 MB (images are embedded
directly in the board file) and downscales anything whose longest side exceeds
2400 px. SVG is passed through untouched — it is already resolution-independent,
and rasterising it would destroy the reason to use it.

A `fileId` that does not resolve renders as a crossed placeholder and is reported
by validation. The element is never deleted.

---

## Adding a type

See [09-extending.md](09-extending.md). In short: write one file in
`src/render/shapes/`, register it, add it to the JSON Schema, and add a `## `
section here. The contract test enforces the last two.
