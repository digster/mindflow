# 4. Coordinates, transforms and geometry

Everything needed to place a MindFlow element on a screen, a page or another
canvas.

Reference implementation: [`src/model/geometry.ts`](../src/model/geometry.ts).

## Spaces

There are exactly two.

### Scene space

The infinite canvas. **All element geometry lives here.**

- One scene unit = one CSS pixel at `zoom === 1`.
- `+x` is right; **`+y` is down** (screen convention, not mathematical).
- The origin `(0, 0)` is arbitrary — simply where a fresh board starts. Elements
  may have negative coordinates, and routinely do.
- Unbounded in every direction.

### Screen space

CSS pixels within the canvas element, origin at its top-left corner.

### Converting between them

These two formulas are the whole of it:

```
screen = (scene − viewport.xy) × viewport.zoom
scene  = screen ÷ viewport.zoom + viewport.xy
```

```js
function sceneToScreen(p, viewport) {
  return { x: (p.x - viewport.x) * viewport.zoom,
           y: (p.y - viewport.y) * viewport.zoom };
}

function screenToScene(p, viewport) {
  return { x: p.x / viewport.zoom + viewport.x,
           y: p.y / viewport.zoom + viewport.y };
}
```

Device pixel ratio is **not** part of this. It is applied once when configuring
the canvas backing store and never enters element geometry — a board renders
identically on a retina and a non-retina display.

## The element's own frame

Two frames matter per element.

**LOCAL** — axis-aligned, origin at the element's top-left `(x, y)`, rotation not
yet applied. All stored geometry lives here: `width`, `height`, and any `points`.
This is why moving an element never rewrites its point array.

**WORLD** — scene space. Obtained by rotating the local frame by `angle` degrees
clockwise about the element's **centre**.

```
centre = (x + width/2, y + height/2)
```

### Rotation

- **Degrees**, not radians.
- **Clockwise** positive, as seen on screen. (With `+y` pointing down, the
  standard rotation matrix produces clockwise motion, so no sign flip is needed.)
- Always about the element's own bounding-box **centre**, never a corner.
- Normalised to `[0, 360)` on load and on save.

```js
function rotatePoint(p, origin, degrees) {
  const r = degrees * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - origin.x, dy = p.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin,
           y: origin.y + dx * sin + dy * cos };
}

function localToWorld(el, local) {
  const abs = { x: el.x + local.x, y: el.y + local.y };
  return rotatePoint(abs, elementCentre(el), el.angle);
}

function worldToLocal(el, world) {
  const c = elementCentre(el);
  const un = rotatePoint(world, c, -el.angle);
  return { x: un.x - el.x, y: un.y - el.y };
}
```

> **`x` and `y` are the top-left of the UNROTATED box.** Once `angle` is non-zero
> they are *not* the visually top-left corner. To find where an element actually
> sits on screen, transform its corners with `localToWorld`.

## Rendering transform

To draw an element so that its local origin is at `(0, 0)` with its own axes:

```js
ctx.save();
ctx.globalAlpha = el.opacity;
ctx.translate(el.x + el.width / 2, el.y + el.height / 2);   // to the centre
ctx.rotate(el.angle * Math.PI / 180);                       // rotate about it
ctx.translate(-el.width / 2, -el.height / 2);               // back to top-left
// … draw at (0,0) → (width, height) …
ctx.restore();
```

The equivalent SVG transform, used by the exporter:

```
translate(cx cy) rotate(angle) translate(-width/2 -height/2)
```

or, when `angle` is 0, simply `translate(x y)`.

**This single convention removes rotation handling from every shape.** Each shape
only ever deals with an axis-aligned box whose top-left is `(0, 0)`.

## Bounding boxes

### Local box

`(0, 0)` to `(width, height)`. Always positive — the format guarantees
`width > 0` and `height > 0`, so no reader ever has to normalise a box before
using it. A "flipped" element is expressed by mirrored geometry or a 180° angle,
never by a negative dimension.

### World AABB

The axis-aligned box containing the *rotated* element. For a rotated element this
is strictly larger than `width × height`.

```js
function elementWorldAABB(el) {
  if (el.angle === 0) {
    return { minX: el.x, minY: el.y,
             maxX: el.x + el.width, maxY: el.y + el.height };
  }
  return aabbFromPoints([
    localToWorld(el, { x: 0,        y: 0 }),
    localToWorld(el, { x: el.width, y: 0 }),
    localToWorld(el, { x: el.width, y: el.height }),
    localToWorld(el, { x: 0,        y: el.height }),
  ]);
}
```

Used for viewport culling, marquee selection, multi-element selection bounds and
export bounds.

### Path elements

For `line`, `arrow` and `draw`, `x`/`y`/`width`/`height` **tightly wrap the
points**. Any edit that changes the points — dragging a vertex, re-routing a bound
connector, finishing a stroke — must re-derive the box and rebase the points so
the element stays visually put:

```
minX, minY   = min over points
width        = max(maxX − minX, 1)      // floored: a horizontal line has zero
height       = max(maxY − minY, 1)      //   extent on one axis
x, y        += minX, minY
points      -= (minX, minY)
```

## Hit-testing

Two rules make it work.

### 1. Pull the pointer into local space

Rather than pushing the shape into world space, transform the pointer *back*
through the inverse rotation. One inverse rotation instead of transforming every
vertex, and every shape then only needs simple axis-aligned maths.

```js
const local = worldToLocal(element, pointerWorld);
if (definition.hitTest(element, local, tolerance)) { /* hit */ }
```

### 2. Tolerance is screen-relative

The base tolerance is **8 screen pixels**, converted to scene units by dividing by
zoom:

```
tolerance = 8 / viewport.zoom
```

Expressing it in scene units instead would make a hairline nearly unclickable when
zoomed out and grab from a centimetre away when zoomed in. Stroked shapes widen it
further by `strokeWidth / 2`, so a thick line is grabbable across its full painted
area.

### Per-type rules

| Type | Hit region |
|---|---|
| `rectangle` | Filled or labelled → anywhere inside. Otherwise → near the outline only. |
| `ellipse` | Filled or labelled → inside the ellipse. Otherwise → near the outline. |
| `diamond` | Filled or labelled → inside the rhombus. Otherwise → near its four edges. |
| `line`, `arrow` | Within `tolerance + strokeWidth/2` of the routed polyline. |
| `draw` | Within `tolerance + strokeWidth/2` of the stroke path. |
| `text`, `sticky`, `image` | Anywhere in the box — these have no hollow interior. |

Elements that are `locked` or `!visible` are skipped entirely.

Iteration runs **back to front** (descending `zIndex`), so the first hit is the
element the user believes they clicked.

## Selection frames

- **One element selected** → the frame is the element's own rotated frame, so
  handles turn with the shape.
- **Several selected** → the frame is the axis-aligned union of their world AABBs,
  with `angle: 0`. There is no meaningful shared rotation, and inventing one makes
  group resizing behave unpredictably.

Handle positions, in the frame's local space (`w`, `h` = frame size):

```
nw (0, 0)        n (w/2, 0)        ne (w, 0)
w  (0, h/2)                        e  (w, h/2)
sw (0, h)        s (w/2, h)        se (w, h)

rotate (w/2, −24/zoom)
```

The rotate handle's offset is divided by zoom so it stays 24 screen pixels above
the shape at every zoom level. The same applies to handle size (9px) and hit slop
(5px): **overlay chrome is always divided by zoom.** That single division is the
entire trick to zoom-invariant UI on a transformed canvas.

## Resizing a rotated element

The requirement, stated precisely: **the anchor — the handle diagonally opposite
the one being dragged — must stay at exactly the same world position throughout.**

Naive implementations drift sideways as the shape grows, because the corner that
was supposed to stay put quietly moved.

The derivation. Let the new box have origin `(x, y)`, size `(w, h)`, rotation `θ`,
and centre `c = (x + w/2, y + h/2)`. For a point at local position `a`, its offset
from the centre is:

```
d = (a.x − w/2, a.y − h/2)
```

Note that `d` depends only on the new **size**, not on the unknown origin. Its
world position is:

```
world = c + R(θ)·d
```

Setting `world` to the anchor's known fixed position and solving for the origin:

```
x = anchorWorld.x − w/2 − (R(θ)·d).x
y = anchorWorld.y − h/2 − (R(θ)·d).y
```

Closed-form, exact, no iteration, and no accumulated drift across a long drag.

Implementation: `resizeFrame` in [`src/input/transform.ts`](../src/input/transform.ts).

### Multi-element resize

Each element's offset and size scale proportionally within the (axis-aligned)
frame. For rotated members this is an **approximation** — a mathematically exact
group resize would shear them, which requires a full affine transform per element
that the format deliberately does not store. Every mainstream whiteboard makes the
same trade. The visible effect is that a rotated shape inside a stretched group
keeps its own aspect distortion rather than skewing.

## Rotating a group

Each element gains `delta` to its own `angle` **and** has its centre swung around
the shared pivot:

```js
const moved = rotatePoint(elementCentre(el), pivot, delta);
el.x = moved.x - el.width / 2;
el.y = moved.y - el.height / 2;
el.angle = normalizeAngle(el.angle + delta);
```

Rotating only the angles would spin every element in place instead of turning the
group as one rigid body.
