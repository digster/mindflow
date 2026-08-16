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

1. Split `text` on `\n` into paragraphs. Explicit breaks are always honoured, and
   an empty paragraph produces an empty line rather than being collapsed.
2. If `maxWidth <= 0`, stop — the paragraphs are the lines. (This is the
   `autoWidth: true` case for `text` elements.)
3. Within each paragraph, split on single spaces into words.
4. Greedily append words to the current line while the measured width of
   `line + " " + word` is `<= maxWidth`. Otherwise flush the line and start a new
   one. Greedy, not Knuth–Plass — simpler, faster, and what every browser and
   canvas tool does.
5. If a single word is itself wider than `maxWidth`, break it **character by
   character**, filling each line as far as it fits. This is what stops a long URL
   overflowing its shape.
6. Trailing spaces are not measured and do not affect breaking.

`maxWidth` is the host box minus padding on both sides:

```
maxWidth = max(element.width − padding × 2, 1)
```

For a `text` element, `padding` is 0. For `sticky`, it is the element's `padding`.
For a `label`, it is the label's `padding`.

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

### Horizontal placement

| `textAlign` | Anchor x (in the inner box) | Canvas `textAlign` / SVG `text-anchor` |
|---|---|---|
| `left` | `padding` | `left` / `start` |
| `center` | `width / 2` | `center` / `middle` |
| `right` | `width − padding` | `right` / `end` |

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

1. Transform the reference point into the target's local frame (`worldToLocal`).
2. Cast a ray from the target's local centre `(w/2, h/2)` toward it. With
   `d = reference_local − centre`:
   - **Ellipse:** solve `(t·dx/rx)² + (t·dy/ry)² = 1`, giving
     `t = 1 / hypot(dx/rx, dy/ry)` where `rx = w/2`, `ry = h/2`.
   - **Every other shape:** the rectangular outline. The ray exits through
     whichever pair of edges it reaches first:
     `t = min(|cx/dx|, |cy/dy|)`, treating a zero denominator as `∞`.
3. The attachment point is `centre + d × t`, transformed back to world space.
4. If `d` is exactly zero, the attachment point is the target's centre.

**Then, in both cases**, apply the gap. With `c` = the target's world centre and
`a` = the attachment point:

```
direction = (a − c) / |a − c|
tip       = a + direction × gap
```

If `|a − c|` is zero, the gap is skipped. This is why an arrow never quite touches
the shape it points at.

### Choosing the reference point

For an `auto` anchor, the reference is the connector's **other end**:

- If the other end is **also bound**, use that target's **centre**.
- Otherwise, use the other end's current world position.

Resolving two auto anchors against each other would be a mutual dependency with no
closed-form solution. Iterating to a fixed point is not worth the complexity for
the pixel or two of difference it would make.

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
