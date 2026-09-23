# 9. Extending MindFlow

How to add an element type, end to end.

The architecture is built around one rule: **no code outside `src/render/shapes/`
may branch on `element.type`.** Everything — the renderer, hit-tester, tools, style
panel, exporter — goes through the element registry. Adding a type therefore means
adding one file and touching the contract, not editing a dozen switch statements.

## Worked example: a `diamond` element

A diamond (rhombus) for flowchart decision nodes. It has no fields of its own,
which makes it the smallest possible complete example.

### 1. Add the type to the model

`src/model/types.ts`:

```ts
export const ELEMENT_TYPES = [
  'rectangle', 'ellipse', 'line', 'arrow',
  'draw', 'text', 'sticky', 'image',
  'diamond',                                  // ← added
] as const;

export interface DiamondElement extends BaseElement {
  type: 'diamond';
}

export type MindflowElement =
  | RectangleElement
  | EllipseElement
  /* … */
  | DiamondElement;                            // ← added
```

### 2. Write the shape module

`src/render/shapes/diamond.ts`. Both `draw` and `hitTest` work in the element's
**local frame** — the renderer has already applied translation and rotation, and
the hit-tester has already pulled the pointer back through the inverse rotation.
You only ever deal with an axis-aligned box from `(0, 0)` to `(width, height)`.

```ts
import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, DiamondElement, Point } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { pointInPolygon, distanceToPolyline } from '../../model/geometry.ts';
import { drawLabel, hasFill, paintPath } from './shared.ts';

/** The four vertices, in local coordinates. */
function vertices(el: DiamondElement): Point[] {
  const { width: w, height: h } = el;
  return [
    { x: w / 2, y: 0 },      // top
    { x: w,     y: h / 2 },  // right
    { x: w / 2, y: h },      // bottom
    { x: 0,     y: h / 2 },  // left
  ];
}

export const diamondDefinition: ElementDefinition<DiamondElement> = {
  type: 'diamond',
  title: 'Diamond',

  capabilities: {
    label: true, path: false, text: false,
    resizable: true, rotatable: true, bindable: true,
  },

  create(init: ElementInit): DiamondElement {
    return {
      id: newElementId(),
      type: 'diamond',
      x: init.x, y: init.y,
      width: Math.max(init.width ?? 120, 1),
      height: Math.max(init.height ?? 80, 1),
      angle: 0, zIndex: init.zIndex, opacity: 1,
      locked: false, visible: true, groupId: null,
      style: { ...DEFAULT_STYLE, ...(init.style as object | undefined) },
      label: null, meta: {},
    };
  },

  // Must tolerate missing, null and wrongly-typed input — hand-authored and
  // machine-generated documents are expected.
  normalize(_raw: Record<string, unknown>, base: BaseElement): DiamondElement {
    return { ...base, type: 'diamond' };
  },

  draw(el: DiamondElement, { ctx }: RenderContext): void {
    const [top, right, bottom, left] = vertices(el) as [Point, Point, Point, Point];
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    paintPath(ctx, el.style);
    drawLabel(ctx, el);
  },

  // Filled shapes are hit anywhere inside; hollow ones only near the outline, so
  // you can click through the middle. Follow this convention.
  hitTest(el: DiamondElement, local: Point, tolerance: number): boolean {
    const points = vertices(el);
    if (hasFill(el.style) || (el.label && el.label.text !== '')) {
      return pointInPolygon(local, points);
    }
    return distanceToPolyline(local, [...points, points[0] as Point]) <= tolerance;
  },
};

registerElement(diamondDefinition);
```

### 3. Register it

`src/render/shapes/index.ts` — one import line:

```ts
import './diamond.ts';                        // ← added
export { diamondDefinition } from './diamond.ts';
```

That is the last of the *code* changes. The renderer, hit-tester, selection,
resize, rotate, grouping, snapping, undo, clipboard, autosave and JSON
serialisation all work now, because none of them know what a diamond is.

### 4. Update the contract

This part is **not optional** — the build fails without it.

**a. The JSON Schema** — `docs/schema/mindflow-1.1.0.schema.json` (a new file;
published schemas are immutable). Add `"diamond"` to the type enum and add a
`$defs` entry:

```jsonc
"diamondElement": {
  "allOf": [
    { "$ref": "#/$defs/baseElement" },
    { "properties": { "type": { "const": "diamond" } }, "required": ["type"] }
  ]
}
```

**b. `docs/03-elements.md`** — add a `## diamond` section and a row in the
capability matrix. The contract test checks that every registered type has a
matching heading.

**c. `docs/CHANGELOG.md`** — record the version bump and why.

**d. `src/model/migrate.ts`** — no migration is needed here: adding a type is
backward-compatible, and older builds preserve unknown elements verbatim (see
[06-persistence.md](06-persistence.md#unknown-element-types)). A migration is only
required when an existing field changes shape.

### 5. Add it to the UI

`src/ui/toolbar.ts` — a `TOOLS` entry, and an icon. Then handle it in the
controller's `beginBoxCreate` case list, alongside `rectangle` and `ellipse`.

**Icons are generated, not written.** `src/ui/icons.ts` carries a
`DO NOT EDIT BY HAND` banner and means it. Add a line to `MANIFEST` in
`scripts/build-icons.mjs` mapping your name to a [Lucide](https://lucide.dev)
slug, then:

```bash
npm run icons
```

Commit the regenerated file along with your change — `test/unit/icons.test.ts`
regenerates it in memory and fails the build if the committed copy is stale, the
same way `index.html` is a committed artifact that must not lag `src/`.

If your type also wants its own colour palette in the style panel, declare one
on the definition:

```ts
palette: { fill: PALETTE.sticky },
```

Optional, and UI-only — it changes what is *offered*, never what the format
accepts.

### 6. Export

`src/render/export.ts` needs a case in `elementToSvg`. **This is the one place
geometry is genuinely expressed twice** — SVG cannot be derived from canvas draw
calls, so the exporter is a second renderer. PNG export needs nothing, since it
reuses the shape module.

```ts
case 'diamond': {
  const w = element.width, h = element.height;
  return `<polygon points="${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}" ${style}/>${labelToSvg(element)}`;
}
```

### 7. Test

```ts
it('round-trips a diamond', () => {
  const doc = createDocument();
  doc.elements.push(diamondDefinition.create({ x: 0, y: 0, zIndex: 1000 }));
  const { document: reloaded } = loadDocument(serializeDocument(doc));
  expect(reloaded.elements[0]?.type).toBe('diamond');
});
```

The contract test will now also verify that the registry, the schema and
`03-elements.md` all agree.

---

## The capability flags

Declared per type, they drive the UI so it need not know about your type.

| Flag | Effect when true |
|---|---|
| `label` | Style panel offers typography; double-click edits the `label`. |
| `path` | Geometry is a `points` list; resize scales the points. |
| `text` | Owns its text directly rather than via `label`; double-click edits it. |
| `resizable` | Selection shows the eight resize handles. |
| `rotatable` | Selection shows the rotate handle. |
| `bindable` | Connector endpoints can attach to it. |

Set `bindable: false` for anything connector-like. Binding connectors to
connectors creates dependency chains with no stable layout fixed point.

`text: true` does **not** have to mean one `text` field. A type that owns many
independent blocks — `table` and its cells — sets the same flag and implements the
text-region members below; every capability-driven consumer (the style panel's
typography row, double-click-to-edit, the search index) then works unchanged.

## Extension points beyond element types

### Arrowheads

Add to `ARROWHEADS` in `types.ts`, a case in `drawArrowhead`
(`shapes/linear.ts`), a case in `arrowheadToSvg` (`export.ts`), and a row in
[07-rendering.md](07-rendering.md#arrowheads).

### Curve styles

Add to `CURVE_STYLES`, then handle it in `routedPoints` and `tracePath`
(`shapes/linear.ts`). **Specify the routing algorithm in
[07-rendering.md](07-rendering.md)** — a curve style whose geometry is not
documented makes files containing it uninterpretable outside MindFlow.

### Text regions

For a type whose text is many independent blocks rather than one, implement three
optional definition members and set `capabilities.text`:

```ts
textRegions(el)          // every block, in tab order: { key, box, text, fontWeight? }
textRegionAt(el, local)  // the key at a local point, or null
withRegionText(el, key, text)   // a copy with that block replaced
```

`key` is **opaque** — the text editor, the controller and `model/search.ts` pass
it around without interpreting it, and `box` is in the element's local frame,
which is all the editor needs to position itself over a cell of a rotated table.
Keeping the key opaque is what stops knowledge of cells leaking back into the
callers this API exists to keep ignorant of them.

`fontWeight` is there for the case where one region is drawn differently from the
rest (a table's header row): the DOM overlay has to match the canvas exactly, or
the text visibly changes weight the moment editing starts.

### Label placement

A type whose text does not belong in the centre of its box implements one
optional member:

```ts
labelBox(el)   // { x, y, width, height } in the element's LOCAL frame
```

Omitting it means "the whole box", which is right for every flat shape. The
solids use it to put a label on the face the viewer is looking at: a label
centred in a cube's bounding box straddles the projected top and side and reads
as floating in front of the shape rather than written on it.

This has to be a registry member rather than a `ctx.translate` inside `draw`,
because the canvas is only one of **three** readers of that box. The DOM text
editor positions itself from it, and the SVG exporter places the same text a
third time. Two of the three disagreeing is precisely the failure mode where
text visibly jumps the moment editing starts — so they all call `labelBoxOf`.

Publish the box in `docs/03-elements.md`: a reader cannot reproduce a labelled
cube without it.

### Interior handles

For a type whose box is subdivided, implement:

```ts
interiorHandles(el)              // { id, axis: 'x' | 'y', position } in the local frame
dragInteriorHandle(el, id, local)  // a complete replacement element
```

The controller offers the drag whenever a single unlocked element declares
handles, with the same hit slop and the same zoom division the outer resize
handles use, and sets a `col-resize`/`row-resize` cursor. It never learns that the
thing being dragged is a column boundary.

`dragInteriorHandle` always receives the element **as it was at pointerdown**, in
line with the rule that every gesture recomputes from its origin rather than
accumulating deltas — so an implementation can be a pure function of the start
state and the pointer.

### Fonts

Add to `FONT_FAMILIES` and to `FONT_STACKS` in `shapes/shared.ts`. Logical names
keep boards portable; never store a concrete typeface.

### The hand-drawn look

Implemented in 1.1.0, and worth reading as a worked example of specifying a
*computed* value rather than a stored one — see
[07-rendering.md](07-rendering.md#hand-drawn-rendering).

To give a new type a hand-drawn form, implement the optional `roughOutline` member
on its definition, returning its outline as a closed polygon in the local frame
with any curves already sampled. Displacement is applied centrally by
`roughOutlineFor` in `src/render/rough.ts`, which both the canvas renderer and the
SVG exporter call — that shared call is the only reason the two agree. Omit
`roughOutline` and the type simply renders cleanly whatever `roughness` says.

## One module, several types

`docs/09-extending.md` says "one file per type" and two modules do not follow it:
`linear.ts` registers both `line` and `arrow`, and `polygons.ts` and `solids.ts`
register five and four types respectively.

The rule that actually matters is *no branching on `element.type` outside
`render/shapes/`* — inside this directory, grouping types that differ only in a
vertex list is the lesser evil. Five files that each held a slightly different
copy of the same `hitTest`, `outlineIntersect` and `create` would be five places
to fix a bug in, and the fifth would be missed. Write one file per type when the
types are genuinely different, and one module per family when they are not.

Each registration is still separate, so the registry, the schema and the docs see
nine ordinary types and nothing downstream knows they share a file.

## Retiring a type

Removing a type is the rarer change and the easier one to get wrong, because a
board that still holds one breaks silently: an unrecognised type is
[preserved but not drawn](06-persistence.md#unknown-element-types), so the shape
disappears from the canvas while lingering in the file. 1.5.0 retired `sphere`,
`prism`, `torus` and `capsule`, and is the worked example.

1. **Remove it everywhere it was added** — the type union in `types.ts`, the shape
   module and its registration, `SHAPE_TOOLS` or the toolbar, its icon in
   `scripts/build-icons.mjs` (then `npm run icons`), and any `case` for it in
   `render/export.ts`.
2. **Publish a new schema version without it**, and bump `CURRENT_SCHEMA_VERSION`.
   The old schema stays exactly as it was.
3. **Write a migration that converts it to a surviving type** rather than an
   identity step. Pick the conversion that keeps the board's layout — the box,
   the hit region and where connectors meet the outline — and record it in the
   changelog precisely enough for another reader to apply it too. Watch for
   style fields the old type stored but never drew and the new one does:
   `roughness` was one.
4. **Take it out of its example board** in `docs/schema/examples/`. Examples
   validate against the *current* schema, so the old example stops validating;
   the migration's own test is the fixture now.
5. **Remove its `## ` section and capability row** from `03-elements.md`. The
   contract test fails if the matrix still lists a type the registry lacks.

## Using `meta` instead

If your extension is *data about* elements rather than a new kind of element, use
the `meta` field. MindFlow never reads, writes or validates it, and always
preserves it across a round trip:

```jsonc
{ "id": "el_x", "type": "rectangle", /* … */
  "meta": { "myTool": { "sourceTicket": "PROJ-142", "reviewed": true } } }
```

This needs no schema change, no migration, and no fork. It is the right answer far
more often than a new element type.

## The rule, restated

> If a reader cannot reproduce a rendered result from the file plus `docs/`, the
> documentation is incomplete.

Adding a type is easy. Adding it *without documenting its geometry* breaks the one
promise this project makes.
