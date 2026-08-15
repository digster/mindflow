# 1. Overview — the mental model

## What a board is

A **board** is an infinite two-dimensional plane containing a flat, ordered list
of **elements**. There are no pages, no layers-as-objects, and no scene graph. A
board is a list.

```
board
├── meta          name, timestamps, which app wrote it
├── canvas        background colour, grid
├── viewport      where the camera was when it was saved
├── elements[]    the flat list — this is the board
└── files{}       embedded binary assets, keyed by content hash
```

## What an element is

An element is a rectangle in space plus a type-specific payload.

Every element — a sticky note, a freehand scribble, an arrow — has the same
**base**: a position, a size, a rotation, a paint order, a style, and a few
booleans. The type then adds its own fields: a rectangle adds `cornerRadius`, an
arrow adds `points` and bindings, an image adds a `fileId`.

This uniformity is the point. A program that understands the base can do
meaningful work with a board full of element types it has never heard of — move
things, compute bounds, reorder, group, export a manifest — without a special
case per type.

## The five design rules

Everything else in this documentation follows from these.

### 1. Flat, never nested

Grouping and connector bindings are expressed by **ID reference**, not by nesting.
There is no tree to walk, no parent pointers to keep consistent, and no ambiguity
about whether a transform is absolute or relative.

The cost is one indirection when you want a group's members. The benefit is that
the element array can be sorted, filtered, sliced, diffed and streamed without
any structural bookkeeping — and that a `git diff` of a board shows exactly what
changed rather than a re-indented subtree.

### 2. Fully resolved, never inherited

Every element carries its complete style. There is no theme, no parent style, no
document default applied at render time.

This means one element, in isolation, is completely interpretable:

```json
{ "id": "el_x", "type": "ellipse", "x": 0, "y": 0, "width": 100, "height": 100,
  "style": { "stroke": "#1e1e1e", "strokeWidth": 2, "fill": "#b2f2bb", ... } }
```

You know exactly how that renders. You did not have to read anything else.

The cost is repetition — a board of fifty identically-styled boxes repeats the
style fifty times. For a format meant to be read by programs and language models,
that trade is worth making: it removes an entire class of "what does this
actually look like?" reasoning.

### 3. Explicit paint order

`zIndex` decides what draws on top. Array order is a *convention* (MindFlow writes
elements sorted ascending by `zIndex`) but `zIndex` is the *truth*. Readers should
sort defensively.

Indices are fractional so that inserting between two elements rewrites one number
instead of renumbering the stack. See [02-document-format.md](02-document-format.md#zindex).

### 4. Degrees, not radians

`"angle": 45` is instantly meaningful to a person or a language model reading raw
JSON. `"angle": 0.7853981633974483` is not. Rotation is clockwise, about the
element's own bounding-box centre, normalised to `[0, 360)`.

### 5. Computed geometry is specified

Some stored values do not directly give a rendered position. An arrow with
`"anchor": {"mode": "auto"}` stores *that it attaches to a shape*, not *where*.
The where is recomputed from the target's current geometry.

Every such computation is specified in [07-rendering.md](07-rendering.md):
auto-anchor resolution, elbow routing, curve smoothing, and text wrapping. Without
those, a file containing a bound arrow would be uninterpretable outside MindFlow,
which would defeat the entire purpose of the format.

## Element types at a glance

| `type` | Shape | Owns text? | Bindable? |
|---|---|---|---|
| `rectangle` | Rounded box | via `label` | yes |
| `ellipse` | Inscribed ellipse | via `label` | yes |
| `line` | Polyline | via `label` | no |
| `arrow` | Polyline with arrowheads and bindings | via `label` | no |
| `draw` | Freehand stroke | no | no |
| `text` | Free-standing text | directly | yes |
| `sticky` | Filled note with text | directly | yes |
| `image` | Embedded bitmap or SVG | via `label` | yes |

"Bindable" means a connector endpoint can attach to it. Connectors are not
bindable to each other — see [07-rendering.md](07-rendering.md#bindings).

Full field reference: [03-elements.md](03-elements.md).

## Two kinds of text

This distinction catches people out, so it is worth stating plainly:

- A **`text` element** is text standing on its own. It has its own position and
  size, and its typography lives directly on the element (`fontSize`, `color`, …).
- A **`label`** is text drawn *inside another element*. It has no position of its
  own — it is laid out within its host's box and rotates with it. Its typography
  lives in the element's `label` object.

A sticky note is a third case: it owns its text directly (like `text`) rather
than through `label`, because a note without text is not a meaningful object.

## What is deliberately absent

- **No real-time collaboration.** No CRDT, no operation log, no presence. A board
  is a file.
- **No server.** The format is designed for a client-side application. Nothing in
  it assumes a backend, an account, or a network.
- **No nesting.** See rule 1.
- **No style inheritance.** See rule 2.
- **No units other than scene units.** No millimetres, no points, no DPI. One
  scene unit is one CSS pixel at zoom 1, and the canvas is unbounded.
