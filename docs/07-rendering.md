# 7. Rendering

Paint order, style semantics, and — most importantly — **the algorithms behind
every computed geometry value**.

This page exists because some stored values do not directly give a rendered
result. An arrow with `"anchor": {"mode": "auto"}` records *that* it attaches to a
shape, not *where*. A sticky note stores `"text"`, not the lines it breaks into.
Without the algorithms below, such a file could only be rendered correctly by
MindFlow itself — which would defeat the purpose of documenting the format at all.

Reference implementations: [`src/render/shapes/`](../src/render/shapes/),
[`src/input/binding.ts`](../src/input/binding.ts),
[`src/render/export.ts`](../src/render/export.ts).

## Paint order

Painter's algorithm, ascending `zIndex`. Higher draws later, therefore on top.

Sort by `zIndex` rather than trusting array order. MindFlow always writes the
array sorted, but `zIndex` is the contract's source of truth and a hand-authored
file may not be sorted.

Elements with `visible: false` are not drawn, not exported and not hit-testable.

Per element, in order:

1. `ctx.globalAlpha = element.opacity` — applies to stroke and fill together.
2. Apply the element transform (see [04-coordinates.md](04-coordinates.md#rendering-transform)).
3. Build the shape's path.
4. Fill, if `fillStyle !== "none"` and `fill` is neither `"transparent"` nor `""`.
5. Stroke, if `strokeWidth > 0` and `stroke` is neither `"transparent"` nor `""`.
6. Draw the `label`, if present and non-empty.

## Style semantics

### When is there a fill?

```
hasFill = fillStyle !== "none" && fill !== "transparent" && fill !== ""
```

Both switches matter. Setting `fill` to a colour while leaving `fillStyle` at
`"none"` renders nothing — MindFlow's own UI keeps them in step by setting
`fillStyle: "none"` whenever the user picks the transparent swatch.

### When is there a stroke?

```
hasStroke = strokeWidth > 0 && stroke !== "transparent" && stroke !== ""
```

### Dash patterns

Scaled by stroke width so a thick dashed line looks proportionate rather than
finely stippled. With `w = max(strokeWidth, 1)`:

| `strokeStyle` | Dash array | Line cap |
|---|---|---|
| `solid` | `[]` | `butt` |
| `dashed` | `[w × 4, w × 3]` | `butt` |
| `dotted` | `[w × 0.1, w × 2.5]` | `round` |

`dotted` relies on a round cap to turn near-zero-length dashes into dots.

Freehand (`draw`) elements ignore `strokeStyle` entirely — ink is never dashed.
Arrowheads are never dashed either, even on a dashed connector.

### Fonts

`fontFamily` is a **logical name**. The stacks:

| Logical | CSS font stack |
|---|---|
| `sans` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| `serif` | `ui-serif, Georgia, Cambria, "Times New Roman", Times, serif` |
| `mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |
| `hand` | `"Segoe Print", "Bradley Hand", Chilanka, "Comic Sans MS", cursive` |

Storing the logical name keeps boards portable and lets the stacks improve later
without rewriting existing files. A renderer with different fonts available should
substitute in the same spirit rather than trying to match glyph-for-glyph.

### Rounded rectangles

`cornerRadius` is clamped at render time:

```
r = clamp(cornerRadius, 0, min(width, height) / 2)
```

so an arbitrarily large value yields a stadium rather than invalid geometry. The
**stored** value is never clamped.

---

## Text wrapping

**Specified algorithm.** Reproduce it exactly to match MindFlow's line breaks.

Given `text`, a `maxWidth` in scene units, and a resolved font:

0. Replace every tab (U+0009), form feed (U+000C) and carriage return (U+000D)
   with a single space (U+0020). See [Whitespace](#whitespace).
1. Split `text` on `\n` into paragraphs. Explicit breaks are always honoured, and
   an empty paragraph produces an empty line rather than being collapsed.
2. If `maxWidth <= 0`, stop — the paragraphs are the lines. (This is the
   `autoWidth: true` case for `text` elements.)
3. Within each paragraph, split on single spaces into words. A paragraph's
   **leading spaces are indentation**: they belong to its first word and are
   drawn. `"  - item"` is the words `"  -"` and `"item"`.
4. Split each word after every hyphen a line may break after — see
   [Hyphens](#hyphens) — into **parts**, keeping each hyphen on the part before
   it. `well-known` is the parts `well-` and `known`. A word without such a
   hyphen is a single part. *(Since 1.6.1.)*
5. Greedily append parts to the current line while the measured width of the
   result is `<= maxWidth`: `line + " " + part` for a word's first part, and
   `line + part` for each later part of the same word. Otherwise flush the line
   and start a new one with the part. Greedy, not Knuth–Plass — simpler,
   faster, and what every browser and canvas tool does. Spaces that fall at a
   break are dropped with it: a line that starts because the previous one was
   full never starts with a space.
6. If a single part is itself wider than `maxWidth`, break it **character by
   character**, filling each line as far as it fits, and continue from the last
   of those lines. This is what stops a long URL overflowing its shape.
7. Trailing spaces are not measured and do not affect breaking.

`maxWidth` is the host box minus padding on both sides:

```
maxWidth = max(element.width − padding × 2, 1)
```

For a `text` element, `padding` is 0. For `sticky`, it is the element's `padding`.
For a `label`, it is the label's `padding`. For a `table` cell, it is the table's
`padding` and the host box is the **cell**, not the element — see
[Tables](#tables).

### Whitespace

Spaces are drawn exactly as written. Runs of spaces are not collapsed, and a
paragraph's leading spaces indent it (step 3). Every other whitespace character
except `\n` is drawn as **one space**, whatever the renderer would do with it
natively (step 0).

For a tab, that is not what most text engines do:

| Engine | A tab renders as |
|---|---|
| Canvas 2D `fillText` / `measureText` | One space. The HTML text preparation algorithm replaces all ASCII whitespace with U+0020, so a canvas renderer gets this rule for free. |
| HTML/CSS with `white-space: pre` or `pre-wrap` | An advance to the next tab stop, 8 spaces apart by default. |
| SVG with `xml:space="preserve"` | One space. |
| SVG in the default whitespace mode | One space, but runs of spaces are then collapsed and leading ones stripped, which breaks the rule above. Emit `xml:space="preserve"`, as MindFlow's exporter does. |

A tab-indented line therefore renders with a one-space indent. MindFlow's own
text editor shows tabs as spaces and writes spaces back when the text is edited,
so text last edited in MindFlow contains no tabs. A file that does contain them is
still valid, and step 0 decides how they look.

A Windows line ending (`\r\n`) leaves a carriage return at the end of each line,
drawn as a trailing space. It is invisible for left-aligned text and shifts a
centred or right-aligned line by half a space or one space.

### Hyphens

*(Since 1.6.1. Before that, lines broke only at spaces.)*

A hyphen-minus (U+002D) that is not the last character of its word may be
followed by a line break, with the hyphen staying at the end of the line. Two
characters decide whether it may:

- `after` is the code point that follows the hyphen.
- `before` is the character in front of it. It counts as **absent** at the
  start of a word, and when it is a paragraph indent's space, which step 3
  glued onto the first word.

| `after` | Break after the hyphen? |
|---|---|
| One of `! $ ) , . / : ; ? ] }` | Never |
| An ASCII digit `0`–`9` | Only if `before` is an ASCII letter or digit |
| Any other ASCII character, including another hyphen | Always |
| A non-ASCII letter (Unicode general category `L`) | Only if `before` is present |
| Any other non-ASCII character | Never |

| Word | Parts |
|---|---|
| `well-known` | `well-` · `known` |
| `2024-09-24` | `2024-` · `09-` · `24` |
| `--verbose` | `-` · `-` · `verbose` |
| `état-major` | `état-` · `major` |
| `-5`, `(-5)`, `é-5` | unsplit: a minus sign, or no ASCII letter or digit before the hyphen |
| `a-.b`, `x-)` | unsplit: closing punctuation follows |
| `-école`, `a-«b»` | unsplit: a word-initial hyphen before a non-ASCII letter, or a quotation mark |
| `ab-` | unsplit: the hyphen ends the word |

**Why this rule.** MindFlow edits text in an HTML `<textarea>` laid over the
canvas, so the browser's line breaker decides where the editor wraps. This is
the rule Blink applies, measured in Chromium 152, so text wraps the same way on
the canvas and in the editor in Chrome and Edge. Blink's line-breaking tables
come from WebKit, so Safari is expected to agree, but that has not been
measured. It is not
UAX #14 verbatim. That standard never breaks between a hyphen and a digit
(rule LB25), so an engine that follows it to the letter keeps `2024-09` whole.

**What is deliberately not included.** Browsers also break after `?` before a
letter, around en and em dashes, before an opening bracket that follows closing
punctuation, and between CJK characters. None of these are break points here.
For CJK, step 6 fills lines character by character, which lands in nearly the
same places.

### Vertical placement

Line advance is `fontSize × lineHeight`. Total block height is
`lineCount × lineHeight × fontSize`. With `available = height − padding × 2`:

| `verticalAlign` | Offset from the top of the inner box |
|---|---|
| `top` | `0` |
| `middle` | `(available − blockHeight) / 2` |
| `bottom` | `available − blockHeight` |

### Baseline

Each line's baseline sits at:

```
baseline = padding + offset + lineIndex × (fontSize × lineHeight) + fontSize × 0.8
```

The `0.8 em` term is a fixed approximation of the cap-height baseline offset.

**Why fixed rather than measured?** So that this document is sufficient. Canvas's
`textBaseline = "middle"` is defined against font-specific metrics and drifts
noticeably between typefaces, and the font that `sans` resolves to differs across
machines. A fixed offset lets a renderer place the baseline knowing only what is
written here.

> **Note for implementers overlaying HTML on the canvas.** CSS does *not* place a
> baseline at `0.8 em`. It places the first baseline of a line box at
> `half-leading + font ascent`, where `half-leading = (lineHeightPx − (ascent +
> descent)) / 2` — a font-specific value, typically around `1.0 em` for the
> default stack, so about a fifth of an em lower than the rule above. Any DOM
> text meant to sit on top of MindFlow's rendering has to measure that offset and
> correct for the difference; MindFlow's own text editor does exactly this, in
> `src/ui/textEditor.ts`. Skipping it makes text drop by a fifth of an em the
> moment editing begins.
>
> Two more things matter for such an overlay. First, show the text through the
> [whitespace](#whitespace) rule, because a `<textarea>` advances a tab to a tab
> stop. Second, stop drawing that text on the canvas while the overlay is open.
> Two layout engines only ever agree to within rounding, and a difference that
> is invisible in one copy of the text shows as two overlapping copies of it.

### Horizontal placement

| `textAlign` | Anchor x (in the inner box) | Canvas `textAlign` / SVG `text-anchor` |
|---|---|---|
| `left` | `padding` | `left` / `start` |
| `center` | `width / 2` | `center` / `middle` |
| `right` | `width − padding` | `right` / `end` |

---

## Tables

**Specified algorithm.** A `table` stores relative track sizes and a flat grid of
strings; everything about where a cell sits and where its text lands is computed.
Reproduce this and a table renders identically outside MindFlow.

### 1. Track sizes

Given the element's `columns` (or `rows`) and the box dimension they run along —
`width` for columns, `height` for rows:

```
weight   = Σ tracks
size[i]  = tracks[i] / weight × total
```

`tracks` values are **proportions, not lengths**. A table resized to twice its
width has the same `columns` array; only `width` changed. A degenerate array
whose entries sum to zero (which MindFlow's loader repairs, but a hand-written
file may contain) divides the space evenly instead: `size[i] = total / count`.

### 2. Track edges

Accumulate the sizes into `tracks.length + 1` boundaries in local coordinates:

```
edge[0] = 0
edge[i] = edge[i−1] + size[i−1]
edge[n] = total          ← pinned, not accumulated
```

Pinning the last edge matters: accumulating `n` floating-point sizes can land a
fraction short of `total`, and a renderer that draws the right-hand border at the
accumulated value leaves a visible hairline gap against the outer box.

### 3. Cell boxes

Cell `(row, column)` occupies, in the element's local frame:

```
x      = columnEdge[column]
y      = rowEdge[row]
width  = columnEdge[column + 1] − columnEdge[column]
height = rowEdge[row + 1]       − rowEdge[row]
```

The cell grid tiles the element's box exactly. There are no gaps, no spans and no
cell outside the box.

### 4. Paint order

1. **Body fill** — the element's `style.fill`, across the whole box, when
   [there is a fill](#when-is-there-a-fill).
2. **Header band** — when `headerRow` is true, `headerFill` across
   `(0, 0)`–`(width, rowEdge[1])`. Painted **over** the body fill rather than
   instead of it, so a translucent header colour composites predictably.
3. **Cell text** — for each non-empty cell, laid out by
   [Text wrapping](#text-wrapping) with `maxWidth = max(cellWidth − padding × 2, 1)`
   inside the cell's box inset by `padding`, using the table's `textAlign`,
   `verticalAlign`, `color`, `fontFamily`, `fontSize` and `lineHeight`. The font
   weight is `max(fontWeight, 600)` for row 0 when `headerRow` is true, and
   `fontWeight` everywhere else. Text is **clipped to its own cell**, so an
   overfull cell looks full rather than spilling into its neighbour.
4. **Rules and border** — when [there is a stroke](#when-is-there-a-stroke), every
   interior edge (`edge[1]` … `edge[n−1]` on both axes) as a full-length line,
   plus the outer rectangle. One path, so a dashed table's dashes run
   continuously rather than restarting at each rule.

### 5. What is not drawn

Nothing distinguishes a header *column*, and `label` is ignored — a table's text
lives in `cells`. A table has no hand-drawn form: `style.roughness` is preserved
but does not affect its rendering, for the same reason `image` and `sticky` have
none (see [Which shapes are roughened](#which-shapes-are-roughened)).

---

## Connector routing

### Elbow routing

**Specified algorithm.** For `curve: "elbow"`, one intermediate corner is inserted
between each consecutive pair of vertices. The leg with the larger absolute delta
is travelled first, so the elbow turns late rather than early:

```
|dx| >= |dy|   →   horizontal first,  corner at (b.x, a.y)
|dx| <  |dy|   →   vertical first,    corner at (a.x, b.y)
```

A pair that is already axis-aligned (`dx === 0` or `dy === 0`) inserts no corner.

### Curve smoothing

**Specified algorithm.** For `curve: "curved"` with **three or more** vertices:

1. Move to the first vertex.
2. For each interior vertex `p[i]` (i from 1 to n−2), draw a quadratic Bézier with
   `p[i]` as the **control point** and the midpoint of `p[i]`–`p[i+1]` as the
   **end point**.
3. Draw a straight line to the last vertex.

The curve therefore *passes through the midpoints* and is merely pulled toward the
interior vertices — which is what keeps it smooth at every joint.

With exactly two vertices there is no interior vertex, so a curved connector is
drawn as a straight line.

**The same algorithm smooths freehand `draw` strokes.** Using one rule everywhere
means an external renderer implements it once.

### Arrowheads

Drawn at an endpoint, oriented along the straight line between the last two
**routed** vertices. On a curved connector that approximates the true tangent; the
error is imperceptible at realistic curvatures and it keeps the rule trivially
reproducible.

With `size = max(strokeWidth × 4, 10)`, `spread = π/7` (≈ 25.7°), and
`angle = atan2(tip.y − from.y, tip.x − from.x)`:

```
wingA = tip − size × (cos(angle − spread), sin(angle − spread))
wingB = tip − size × (cos(angle + spread), sin(angle + spread))
```

| Kind | Geometry |
|---|---|
| `none` | Nothing drawn. |
| `arrow` | Open polyline `wingA → tip → wingB`, stroked. |
| `triangle` | Filled polygon `tip, wingA, wingB`. |
| `dot` | Filled circle at `tip`, radius `max(strokeWidth × 1.6, 4)`. |
| `bar` | Line through `tip` perpendicular to `angle`, length `size`. |

---

## Solids

The four solid types — `cube`, `cylinder`, `cone` and `pyramid` — are drawn in a
fixed oblique projection. Every part of that projection is *computed*, so this
section is what a reader needs in order to reproduce one from a file that stores
nothing but a box.

### The depth offset

One number drives all four:

```
d = 0.25 × min(width, height)
```

Depth runs **up and to the right**, and every vertex lies inside
`(0, 0)`–`(width, height)`. Per-type vertex lists are in
[03-elements.md](03-elements.md#cube).

### Curve sampling

Round solids sample their arcs to polylines before drawing, so that a canvas
renderer and an SVG exporter produce identical geometry. For an arc of radii
`rx`, `ry` sweeping `θ` radians:

```
perimeter = π(3(rx + ry) − √((3·rx + ry)(rx + 3·ry)))      (Ramanujan)
spaced    = ceil((θ / 2π) × perimeter / 12)
segments  = clamp(ceil(spaced / 4) × 4, 4, 64)
```

with `segments + 1` points placed at equal angular steps from the start angle to
the end angle. The spacing rule is the one used for the hand-drawn ellipse above
at twice the resolution — these are clean curves, and the jitter that hides
faceting there is absent here.

**Rounding the count up to a multiple of four is required, not cosmetic.** It
places a sample exactly on the arc's midpoint, and on all four quadrant points of
a full ellipse. Those are the tangent points where a curve touches the element's
box, so a renderer that samples otherwise produces a silhouette that falls short
of its own bounding box.

### Faces and tones

A solid is a list of faces painted **back to front**, each filled with a tone
derived from the element's single `style.fill` and stroked with the element's own
`style.stroke`. Every edge between two faces is therefore an ordinary stroke, and
there is no separate seam geometry.

The three tones, per sRGB channel `c` of the fill, with the shade amount
**0.15**:

| Tone | Formula |
|---|---|
| base | the fill, unchanged |
| lit | `round(c + (255 − c) × 0.15)` |
| shaded | `round(c × (1 − 0.15))` |

An alpha component, if the fill carries one, is passed through unchanged.

**A fill that is not a hex colour is used unchanged for every face.** That
includes `transparent`, CSS keywords and any function notation. This is
specified rather than left open because the alternative — each renderer guessing
a tone in its own colour space — is how two implementations come to disagree
about the same file.

When `style.fillStyle` is `"none"`, no face is filled at all and the solid is
drawn as its stroked edges.

### Labels on a solid

A solid's `label` is drawn in its **label box**, not in its bounding box — on a
cube, the front face. The per-type boxes are listed in
[03-elements.md](03-elements.md#cube). A renderer that ignores this and centres
the label in the bounding box will place text that straddles the projected top
and side faces.


## Binding resolution

**The most important algorithm here.** A bound connector's stored `points` are a
*cache* of the last computed route. Any reader that moves a bound element must
recompute them, or the arrow will visually detach from its target.

### Resolving one endpoint

Inputs: the target element, the binding, and a **reference point** (see below).

**Fixed anchor** (`{"mode": "fixed", "u": u, "v": v}`):

1. Take the local point `(u × target.width, v × target.height)` on the target's
   unrotated box.
2. Transform it to world space through the target's rotation
   (`localToWorld`).

**Auto anchor** (`{"mode": "auto"}`):

1. Cast a ray from the target's local centre `(w/2, h/2)` toward the reference
   point, and take where it crosses the outline. See
   [Casting a ray at the outline](#casting-a-ray-at-the-outline).
2. If the reference point is exactly the centre, the attachment point is the
   centre.

**Focus anchor** (`{"mode": "focus", "u": u, "v": v}`, added in 1.6.0):

1. The **focus point** is the local point `(u × target.width, v × target.height)`.
2. Cast a ray from the focus point toward the reference point, and take its
   **last** crossing of the outline — the point where it finally leaves the shape.
3. If there is no crossing, or the reference point is exactly the focus point,
   resolve the binding as `auto` instead.

A ray from inside the outline always crosses it, so step 3 applies only to a
focus point that lies inside the bounding box but outside the outline (a corner
of an ellipse's box, the notch of a star) with the ray pointing away from the
shape. MindFlow never writes a focus point outside the box, and a reader should
clamp `u` and `v` to `[0, 1]` before casting.

`auto` is exactly `focus` at `(0.5, 0.5)`. The two are separate modes because
aiming through the centre is the natural default for a board written by hand or
by a script, and it needs no numbers.

**Then, in every case**, apply the gap: push the attachment point `a` a distance
`gap` further along the direction the tip leaves the shape.

```
fixed, auto:  direction = (a − c) / |a − c|     c = the target's world centre
focus:        direction = (a − f) / |a − f|     f = the focus point, in world space
tip           = a + direction × gap
```

For `auto` the two formulas agree, since the ray starts at the centre. For
`focus` they do not, and using the centre would slide the tip sideways along the
outline instead of backing it away. If `|a − c|` (or `|a − f|`) is zero, the gap
is skipped. This is why an arrow never quite touches the shape it points at.

### Casting a ray at the outline

Work in the target's local frame: transform the reference point with
`worldToLocal`, cast from the origin `o` (the centre, or the focus point) with
direction `d = reference_local − o`, and transform the crossing back with
`localToWorld`. The crossing is `o + t·d` for the **largest** `t ≥ 0` at which
the ray meets the outline. The outline is **per shape**, with the rectangular
case as the default for any type not listed:

| Target | Crossing |
|---|---|
| `ellipse` | With `p = o − (a, b)`, the larger root of `A·t² + B·t + C = 0`, where `A = (dx/a)² + (dy/b)²`, `B = 2·(px·dx/a² + py·dy/b²)`, `C = (px/a)² + (py/b)² − 1`. No real root, or a negative one, is no crossing. |
| `diamond`, the flat polygons, the solids | The polygon rule below, on the rhombus, the polygon's vertices or the solid's silhouette. |
| **everything else** | `t = min(tx, ty)`, with `tx = (w − ox)/dx` when `dx > 0`, `−ox/dx` when `dx < 0`, and `∞` when `dx = 0` — the ray leaves through whichever wall it reaches first. `ty` likewise, with `h` and `oy`. |

In all three, `a = w/2` and `b = h/2`.

From the centre these reduce to the closed forms 1.5.0 and earlier specified —
`1 / hypot(dx/a, dy/b)` for an ellipse, `1 / (|dx|/a + |dy|/b)` for a diamond,
`min(|a/dx|, |b/dy|)` for a rectangle — so an `auto` anchor resolves exactly as
it always has.

A reader that does not recognise a type should use the rectangular default: it is
always a defined answer, and it is what MindFlow itself does for any shape that
does not declare an outline of its own.

### Polygonal outlines

The diamond, the flat polygons and the solids share one rule: intersect the ray
with each edge of the outline in turn and take the crossing with the **largest**
non-negative parameter. With the origin `o`, an edge running `p → q` and a
direction `d`, the crossing solves

```
o + t·d = p + u·(q − p),    t ≥ 0,  0 ≤ u ≤ 1
```

a 2×2 system whose determinant is the 2D cross product of `d` and `q − p`; a
determinant of zero means the edge is parallel to the ray and is skipped. If no
edge is crossed, there is no crossing — for an `auto` anchor that can only mean a
degenerate polygon, and the rectangular default applies.

Taking the largest `t` rather than the smallest is what makes a `star` anchor to
the tip of a point instead of to the notch between two of them. For a convex
outline cast from inside, there is only one crossing anyway.

The outline used is the type's silhouette, which for a solid is the outside of
its projection rather than any one face.

### Choosing the reference point

For an `auto` or `focus` anchor, the reference is the connector's **other end**:

- If the other end is **also bound**, use the point that end's anchor **aims
  at**: its target's centre for `auto`, and its `(u, v)` point, in world space,
  for `focus` and `fixed`.
- Otherwise, use the other end's current world position.

The aim point depends only on the other target and its stored anchor, never on
where either tip currently sits. Resolving the tips against each other would be a
mutual dependency with no closed-form solution, and iterating to a fixed point
is not worth the complexity for the pixel or two of difference it would make.

Two focus anchors therefore aim at each other's focus points, and the connector
is the segment between them, trimmed at each outline — the line that was drawn.

> **Changed in 1.6.0.** Until 1.5.0 a bound other end always contributed its
> target's **centre**. The two rules agree when the other end is `auto`. When it
> is `fixed`, this end now aims at the pinned spot rather than past it at the
> centre. A board's stored points are only a cache, so this takes effect the
> next time either shape moves.

### Applying the result

1. Compute the new world positions of the first and/or last point.
2. Convert each to the connector's local frame (`worldToLocal`) and write it into
   `points`.
3. **Re-derive the connector's bounding box** and rebase its points — see
   [04-coordinates.md](04-coordinates.md#path-elements). Skipping this leaves
   `width`/`height` describing the old extent, breaking culling and hit-testing.

### When to re-route

Whenever any element referenced by a binding moves, resizes or rotates. MindFlow
does this on every geometry change, and skips connectors whose endpoints did not
actually shift so a no-op move produces no patch.

---

## Hand-drawn rendering

`style.roughness` displaces a shape's outline to make it look sketched. `0` — and
any value at or below `0.001` — renders clean geometry. This section specifies
the displacement completely, because a partially specified one would be worse
than none: two renderers would each draw something plausible, and disagree.

### The seed is derived, not stored

Jitter needs a seed. There is no `seed` field, and there deliberately never will
be: **the seed is the element's `id`.**

Ids are already in the file, already stable across a save/load round trip, and
already re-minted when an element is duplicated — so a copy gets its own squiggle
without any extra machinery. Storing a seed would have been a structural change
to every element for a value that can be computed from one already there.

The consequence to be aware of: **changing an element's `id` changes how it
looks.** Ids are stable in normal use, so this is only a trap for a tool that
rewrites them.

### Hashing the id

FNV-1a, 32-bit, over the id's UTF-16 code units:

```js
function hashSeed(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;   // × 16777619, mod 2³²
  }
  return hash >>> 0;
}
```

Reference values: `hashSeed("")` is `2166136261` (`0x811c9dc5`), and
`hashSeed("el_q2WikW58Aw")` is `3578049225`.

### The generator

Mulberry32, producing values in `[0, 1)`:

```js
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

Seeded with `hashSeed("el_q2WikW58Aw")`, the first three values are
`0.8391014873`, `0.2622082005`, `0.6914683564`.

**One stream per element**, created once and drawn from in the order below. Two
edges of the same shape must not restart it, or opposite sides would jitter
identically.

### Which shapes are roughened

| Type | Outline sampled to |
|---|---|
| `rectangle` | Its rounded outline. Straight sides are single edges; each corner arc is sampled at **4 segments per quarter turn**, with the radius clamped to half the shorter side as usual. A radius of `0` gives the four corners only. |
| `ellipse` | A closed polygon of `clamp(ceil(perimeter / 24), 8, 64)` evenly spaced points, where `perimeter` is Ramanujan's first approximation `π(3(a+b) − √((3a+b)(a+3b)))` with `a = w/2`, `b = h/2`. |
| `diamond` | Its four vertices. |
| `triangle`, `pentagon`, `hexagon`, `star`, `parallelogram` | Their own vertices, listed in [03-elements.md](03-elements.md#flat-polygons). |
| everything else | **Not roughened.** `line`, `arrow`, `draw`, `text`, `sticky`, `image`, `frame`, `table` and every solid render cleanly whatever `roughness` says. For the solids this is a consequence of the rule rather than an omission: the displacement below is defined on ONE closed polygon, and a cube is three faces whose shared edges would vanish if its silhouette were roughened as a single outline. |

Curves are sampled to polylines *before* displacement so that exactly one jitter
rule exists.

### The displacement

Walk the polygon edge by edge, in order. For an edge from `p` to `q` of length
`L`:

1. `samples = clamp(ceil(L / 24) + 1, 2, 32)`.
2. For each sample `s` in `0 … samples−1`, the point on the edge is
   `p + (q − p) × s/(samples−1)`.
3. **Sample `0` is emitted unchanged.** It is a vertex, and displacing it would
   tear the outline open where two edges meet.
4. **The last sample is not emitted at all** — it is the next edge's sample `0`,
   and emitting it would duplicate every vertex. (On an *open* polyline the final
   edge does emit it, so the line reaches its end.)
5. Every interior sample is displaced along the edge's unit normal
   `n = (−dy/L, dx/L)` by `(random() × 2 − 1) × 1.6 × roughness`, drawing exactly
   one value from the stream per interior sample.

A closed polygon repeats its first emitted point at the end.

So the amplitude at `roughness = 1` is ±1.6 scene units, and the field's maximum
of `2` gives ±3.2.

### Reader expectations

A reader that cannot reproduce this **must still accept and preserve** any
`roughness` value, and may render the shape cleanly. Rendering at `0` is a
legitimate degradation; silently dropping the field is not.

## Freehand strokes

Traced with the same quadratic-midpoint smoothing as curved connectors.

A single captured point renders as a dot: a zero-length line with a round cap.

**Pressure.** When `pressureSensitive` is true, the stroke is drawn as a run of
individually-stroked segments at interpolated widths, mapping pressure `0..1` onto
`0.4×..1.4×` of `strokeWidth`:

```
segmentWidth = strokeWidth × (0.4 + (pressure[a] + pressure[b]) / 2)
```

Canvas has no variable-width stroke. The alternatives are to build an outline
polygon (accurate, considerably more code) or to stroke short segments at
interpolated widths (approximate, very cheap). MindFlow takes the second: with
round caps and joins the seams are invisible, and freehand ink is forgiving.

The floor of `0.4×` ensures a stroke never vanishes entirely at low pressure.

---

## The grid

Drawn beneath every element when `canvas.grid.visible`.

**Coarsening.** Below roughly 6 screen pixels per cell the lines merge into a grey
wash, so the spacing doubles until it is legible again:

```
step = grid.size
while (step × zoom < 6) step ×= 2
```

Without this, zooming out on a fine grid both looks wrong and costs thousands of
pointless line segments.

Line width is `1 / zoom`, which cancels the context scale and yields a true
hairline at any zoom. Colour: `rgba(0, 0, 0, 0.08)`.

---

## Performance

The renderer repaints the whole visible scene on any change, scheduled through
`requestAnimationFrame` and skipped entirely when nothing is dirty.

**Viewport culling** is the one optimisation that is implemented: each element's
world AABB is tested against the visible scene bounds before drawing. On a large
board this skips almost everything, and it is the difference between smooth
panning and a slideshow.

Deliberately **not** implemented, and noted in `ARCHITECTURE.md` as the levers to
reach for if a board ever demands them:

- **Damaged-region tracking** — a large amount of subtle code that mostly buys
  back what culling already gives.
- **A separate interaction canvas** — would avoid repainting the scene while
  dragging selection handles.

Measured on the reference implementation, a 2,000-element board pans and zooms at
60fps with culling alone.

---

## Export

### PNG

Reuses the shape modules against an offscreen canvas, so output is pixel-identical
to the screen. Content bounds plus padding, multiplied by a scale factor.

The scale is capped so the canvas cannot exceed 16,000px on a side — most browsers
refuse larger and fail *silently*, producing a blank image rather than an error.

### SVG

A **second renderer**, not derived from the canvas code. A `draw()` that issues
canvas calls produces pixels, not markup, so SVG output has to be generated
independently.

That means shape geometry is expressed twice and the two can drift. The mitigation:
both are driven from the algorithms specified on this page, and the shared maths
(smoothing, routing, text layout) is imported rather than re-derived — only the
output *syntax* differs.

Exported SVG is self-contained: images are inlined as data URIs, so the file opens
anywhere without accompanying assets.

**One known difference from the canvas: text is not clipped.** The canvas clips a
sticky note's text to the note and a table cell's text to its cell; the SVG
exporter emits the text without a clip path, so an overfull note or cell shows
the overflow instead of hiding it. Wrapping means this only ever arises
vertically — text that is too *wide* has already been broken across lines — and
the alternative is a `<clipPath>` per note and per cell, which would bloat the
document for a case the author can see and fix on the board.
