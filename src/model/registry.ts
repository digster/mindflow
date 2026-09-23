/**
 * The element registry.
 *
 * Every element type registers one definition here, and every other subsystem —
 * renderer, hit-tester, tools, style panel, serialiser — goes through it. No
 * code outside `render/shapes/` may branch on `element.type`.
 *
 * Two things fall out of that discipline:
 *
 *   1. Adding a shape means writing one file and registering it. Nothing else
 *      changes. `docs/09-extending.md` walks through exactly that.
 *
 *   2. The registry becomes a runtime-inspectable list of supported types, which
 *      `test/unit/contract.test.ts` compares against the JSON Schema. TypeScript
 *      types vanish at runtime and cannot be checked this way; the registry can.
 *      That is what gives the docs-as-contract rule actual teeth instead of
 *      being a promise we would inevitably drift away from.
 */

import type {
  BaseElement,
  ElementType,
  FrameElement,
  ImageElement,
  LinearElement,
  MindflowDocument,
  MindflowElement,
  PathElement,
  Point,
} from './types.ts';

/**
 * Everything a shape needs from the outside world in order to draw itself.
 *
 * Passed rather than imported so that shape modules stay pure and testable, and
 * so the same drawing code serves the on-screen canvas, PNG export and SVG
 * export without knowing which is which.
 */
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  /** Current zoom, for level-of-detail decisions and for keeping hairlines crisp. */
  zoom: number;
  /** The document being drawn, so shapes can resolve `files` and binding targets. */
  document: MindflowDocument;
  /** Decoded images, keyed by `fileId`. Missing entries render as a placeholder. */
  images: Map<string, CanvasImageSource>;
  /** True while rendering for export, where interactive affordances are omitted. */
  exporting: boolean;
}

/** Initial geometry supplied when a tool creates an element. */
export interface ElementInit {
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex: number;
  /** Type-specific overrides, applied after defaults. */
  [key: string]: unknown;
}

export interface ElementCapabilities {
  /** Can carry an `ElementLabel` drawn inside it. */
  label: boolean;
  /** Geometry is a point list (`points`) rather than a plain box. */
  path: boolean;
  /** Owns text directly and can be edited with the text editor. */
  text: boolean;
  /** Can be resized by dragging selection handles. */
  resizable: boolean;
  /** Can be rotated. */
  rotatable: boolean;
  /** May be the target of a connector binding. */
  bindable: boolean;
  /**
   * Is a connector: its ends can bind to other elements (`startBinding` and
   * `endBinding`), it is re-routed when they move, and it gets the line-shape
   * and arrowhead controls. Declaring it promises the `LinearElement` fields;
   * see {@link isConnector}.
   *
   * No combination of the other flags says this. `path && !bindable` also
   * describes a freehand `draw` stroke, which has points but no bindings.
   */
  connector: boolean;
  /**
   * Acts as a frame: other elements join it through their `frameId`, and it
   * clips them, carries them when it moves and deletes them with it. Frames
   * never contain frames. Declaring it promises the `FrameElement` fields
   * (`name`); see {@link isFrame}.
   */
  frame: boolean;
  /**
   * Displays a binary from the document's `files` map, referenced by
   * `fileId`. The file is decoded for drawing, travels with the element on
   * copy, and must resolve for the document to validate. Declaring it
   * promises the `ImageElement` fields; see {@link hasFile}.
   */
  file: boolean;
  /**
   * The style panel offers fill colour and fill style. This is a UI flag, not
   * a rendering one: every element stores `style.fill`, and whether it is
   * painted is up to the type. `image` has the controls but never paints the
   * fill, which is how the panel behaved before the flag existed.
   */
  fillable: boolean;
}

/**
 * The contract each element type implements.
 *
 * Note that both `draw` and `hitTest` work in the element's LOCAL frame: the
 * renderer has already applied translation and rotation, and the hit-tester has
 * already pulled the pointer back through the inverse rotation. A shape
 * therefore only ever deals with an axis-aligned box whose top-left is (0,0) and
 * whose size is `width` x `height`. That single convention removes rotation
 * handling from every shape module.
 */
export interface ElementDefinition<T extends MindflowElement = MindflowElement> {
  type: T['type'];
  /** Label shown in the UI. */
  title: string;

  /** Builds a complete, valid element from partial initial geometry. */
  create(init: ElementInit): T;

  /**
   * Fills in this type's own fields on an element loaded from a file, given an
   * already-normalised base. Must tolerate missing, null and wrongly-typed
   * input — hand-authored and machine-generated documents are expected, and a
   * malformed field should degrade to its default rather than throw.
   */
  normalize(raw: Record<string, unknown>, base: BaseElement): T;

  /** Draws the element in local space. */
  draw(el: T, render: RenderContext): void;

  /**
   * True when `local` touches the element.
   *
   * `tolerance` is in scene units and already scaled for the current zoom, so a
   * thin line stays as easy to grab when zoomed out as when zoomed in.
   */
  hitTest(el: T, local: Point, tolerance: number): boolean;

  /**
   * Where the ray `localOrigin + t·localDirection` crosses the element's
   * outline for the LAST time (the largest `t ≥ 0`), in the LOCAL frame, or
   * `null` if it never does. Optional; omitting it means "my outline is my
   * bounding rectangle", which is right for most shapes.
   *
   * This exists so auto- and focus-anchored connectors can attach to a shape's
   * real edge rather than its bounding box. It was previously a
   * `type === 'ellipse'` branch inside `geometry.ts` — the one place outside
   * `render/shapes/` that broke the no-branching-on-type rule, and the reason
   * adding a diamond would otherwise have had to break it a second time.
   *
   * The origin is the element's centre for an `auto` anchor and the stored focus
   * point for a `focus` one. From an origin inside the outline there is always
   * exactly one exit, so `null` only arises when a focus point lies inside the
   * bounding box but outside the outline (the corner of an ellipse's box, the
   * notch of a star) and the ray points away from the shape. The caller then
   * falls back to the `auto` rule.
   *
   * `localDirection` is a vector, not a point, and need not be normalised. The
   * caller handles rotation and the connector gap.
   *
   * Published in `docs/07-rendering.md`: an external renderer needs this to
   * reproduce a bound connector, so a new implementation is a format change.
   */
  outlineIntersect?(el: T, localDirection: Point, localOrigin: Point): Point | null;

  /**
   * The element's outline as a closed polygon in the LOCAL frame, used as the
   * input to hand-drawn rendering (`style.roughness`). Curves must already be
   * sampled — the jitter rule is defined on polylines only.
   *
   * Omitting it means this type has no hand-drawn form and renders cleanly
   * whatever `roughness` says, which is the right answer for content containers
   * like `image`, `text` and `sticky`.
   *
   * It exists on the registry rather than inside each renderer because the
   * canvas and the SVG exporter are two independent renderers: having both
   * consume the same generated points is the only way they can agree.
   */
  roughOutline?(el: T): Point[];

  /**
   * Where this type draws its `label`, in the LOCAL frame. Optional; omitting it
   * means "the whole box", which is right for every flat shape.
   *
   * It exists for the solids, whose front face is inset from the box: a cube's
   * label belongs on the face the viewer is looking at, not floating across the
   * projected top and side. That cannot be done with a `ctx.translate` inside
   * `draw`, because the canvas is only one of THREE readers of this box — the
   * DOM text editor positions itself from it too, and the SVG exporter places
   * the same text a third time. Two of those disagreeing is the failure mode
   * where text visibly jumps the moment editing starts, so the box has to come
   * from one place.
   *
   * Published in `docs/03-elements.md` per type: a reader cannot reproduce a
   * labelled cube without it.
   */
  labelBox?(el: T): { x: number; y: number; width: number; height: number };

  /**
   * The element's editable text sub-regions, in tab order.
   *
   * Most types own either one block of text (`capabilities.text`) or a `label`,
   * and the editor addresses the element as a whole. A grid-like type owns many
   * independent blocks, and "which one am I editing?" has to be expressible
   * without any caller knowing what a cell is — hence an opaque `key` plus a box
   * in the element's LOCAL frame, which is all the text editor needs to place
   * itself and all the search index needs to read the words.
   *
   * Implementing this makes `capabilities.text` mean "owns its text directly,
   * addressed by region" rather than "has a `text` field".
   */
  textRegions?(el: T): TextRegion[];

  /**
   * The region containing `local`, or `null`. Separate from {@link textRegions}
   * so hit-testing a click does not have to materialise every region's text.
   */
  textRegionAt?(el: T, local: Point): string | null;

  /** A copy of `el` with the named region's text replaced. */
  withRegionText?(el: T, key: string, text: string): T;

  /**
   * A copy of `el` carrying `text`, for a type that owns one block of text
   * (`capabilities.text` without regions). Optional. Omitting it means
   * `{ ...el, text }` with the box unchanged, which is right for a sticky
   * note, whose text wraps inside a box the user sized.
   *
   * It exists for types whose box is derived from their content: a `text`
   * element re-measures itself on every keystroke. That was previously a
   * `type === 'text'` branch in the DOM text editor.
   */
  withText?(el: T, text: string): T;

  /**
   * Whether `el`'s text wraps to its box. Optional; omitting it means it does.
   *
   * Per element rather than a capability flag because the answer depends on
   * a field: a `text` element with `autoWidth` never wraps, and its box grows
   * to the widest line instead. The DOM text editor must lay text out the way
   * the canvas does, or its line count and the baseline offset derived from
   * it disagree with what is drawn. Before this member existed, the editor
   * asked with a `type === 'text'` branch.
   */
  wrapsText?(el: T): boolean;

  /**
   * Draggable dividers *inside* the element, for types whose box is subdivided.
   *
   * Deliberately not modelled as extra selection handles: those describe the
   * element's outer frame and are shared by every type, whereas these are
   * interior structure that only the type itself can enumerate. Keeping them on
   * the definition means the controller can offer the gesture without knowing
   * that the thing it is dragging is a column boundary.
   */
  interiorHandles?(el: T): InteriorHandle[];

  /**
   * Applies a drag of the named interior handle to `local`, a point in the
   * element's LOCAL frame. Returns a complete replacement element; the caller
   * always passes the element as it was at pointerdown, so the result is
   * recomputed from the gesture origin rather than accumulated frame to frame.
   */
  dragInteriorHandle?(el: T, id: string, local: Point): T;

  /**
   * Problems with `el` that only its type can recognise, as human-readable
   * messages. `validateDocument` reports each as an `error` at the element's
   * path, after the checks every element gets. Optional; most types have
   * nothing to add.
   *
   * A hook rather than a flag because the rule and its wording belong to the
   * type: a freehand stroke needs a point to be drawn at all. Expressing that
   * outside `render/shapes/` would mean identifying `draw` as
   * `path && !connector`, which is exactly the flag arithmetic that breaks
   * when a new path type arrives.
   */
  validate?(el: T): string[];

  /**
   * Colour palettes this type offers in the style panel, overriding the
   * defaults in `PALETTE`.
   *
   * Optional, and consulted only by the UI — it has no effect on the file
   * format, which accepts any CSS colour for any element. It exists because a
   * sticky note wants the warm paper tones it is actually created with, not the
   * pastel washes a rectangle wants, and the alternative was a
   * `type === 'sticky'` branch in the style panel. Same reasoning as
   * {@link textRegions} and {@link interiorHandles}: an optional hook on the
   * definition keeps the no-branching-on-type rule intact and costs existing
   * types nothing.
   */
  palette?: {
    stroke?: readonly string[];
    fill?: readonly string[];
  };

  capabilities: ElementCapabilities;
}

/** One independently editable block of text inside an element. */
export interface TextRegion {
  /** Opaque within the element; stable for as long as the region exists. */
  key: string;
  /** Where the text sits, in the element's LOCAL frame. */
  box: { x: number; y: number; width: number; height: number };
  text: string;
  /**
   * Font weight for this region alone, when it differs from the element's own
   * `fontWeight` — a table draws its header row heavier than its body. Present
   * so the DOM text editor can match the canvas exactly; omitted otherwise, so
   * the editor's baseline cache is not keyed on a redundant value.
   */
  fontWeight?: number;
}

/** A draggable divider inside an element. See {@link ElementDefinition.interiorHandles}. */
export interface InteriorHandle {
  /** Opaque; passed back to `dragInteriorHandle`. */
  id: string;
  /** The axis the divider moves along: `x` for a vertical line, `y` for a horizontal one. */
  axis: 'x' | 'y';
  /** Position along that axis, in the element's LOCAL frame. */
  position: number;
}

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

const registry = new Map<string, ElementDefinition<never>>();

export function registerElement<T extends MindflowElement>(definition: ElementDefinition<T>): void {
  if (registry.has(definition.type)) {
    throw new Error(`Element type "${definition.type}" is already registered`);
  }
  registry.set(definition.type, definition as unknown as ElementDefinition<never>);
}

/** Looks up a definition, throwing on an unknown type. */
export function getDefinition<T extends MindflowElement>(type: T['type'] | string): ElementDefinition<T> {
  const definition = registry.get(type);
  if (!definition) {
    throw new Error(
      `Unknown element type "${type}". Registered types: ${[...registry.keys()].join(', ')}`,
    );
  }
  return definition as unknown as ElementDefinition<T>;
}

/** Looks up a definition, returning `undefined` rather than throwing. */
export function findDefinition(type: string): ElementDefinition<MindflowElement> | undefined {
  return registry.get(type) as ElementDefinition<MindflowElement> | undefined;
}

export function isRegistered(type: string): type is ElementType {
  return registry.has(type);
}

/** Every registered type, sorted for stable comparison in the contract test. */
export function registeredTypes(): string[] {
  return [...registry.keys()].sort();
}

export function allDefinitions(): ElementDefinition<MindflowElement>[] {
  return [...registry.values()] as ElementDefinition<MindflowElement>[];
}

/** Convenience wrappers so callers need not fetch the definition first. */
export function capabilitiesOf(el: MindflowElement): ElementCapabilities {
  return getDefinition(el.type).capabilities;
}

/*
 * Capability type guards.
 *
 * These are how code outside `render/shapes/` asks "is this a connector?",
 * "does this have points?", "is this a frame?" or "does this show a file?"
 * without naming types, which it may not do. They return type predicates
 * rather than plain booleans because the `type ===` comparisons they replace
 * narrowed the union for free. Without the narrowing, every caller would need
 * a cast to reach `points`, `startBinding`, `name` or `fileId`.
 *
 * A capability with no fields behind it (`fillable`) needs no guard, so
 * callers read it through `capabilitiesOf`.
 *
 * TypeScript cannot check that the narrowing is sound: a flag in a definition
 * says nothing about the fields its elements carry. `contract.test.ts` checks
 * it instead, by asserting that every definition's `create()` output has
 * exactly the fields its flags promise.
 *
 * Both look up with `findDefinition` and answer `false` for an unregistered
 * type instead of throwing like `capabilitiesOf`. That matches the behaviour
 * of the comparisons they replaced, and a predicate should be safe to call on
 * anything.
 */

/**
 * True for connectors, the elements with `startBinding` and `endBinding`.
 *
 * Why a capability rather than the structural test `'startBinding' in el`:
 * most callers are not asking about bindings. The style panel wants
 * "show arrowhead controls", and validation wants "needs at least two points".
 * Those are facts about being a connector, and a flag declared next to the
 * type's other capabilities says so in one place. A structural test would
 * stay silently true for any future type that reuses the field name for
 * something else.
 */
export function isConnector(el: MindflowElement): el is LinearElement {
  return findDefinition(el.type)?.capabilities.connector === true;
}

/** True for elements whose geometry is a `points` list (`capabilities.path`). */
export function isPathElement(el: MindflowElement): el is PathElement {
  return findDefinition(el.type)?.capabilities.path === true;
}

/**
 * True for frames (`capabilities.frame`), the elements other elements join
 * through `frameId`. Narrows to `FrameElement` for its `name`.
 */
export function isFrame(el: MindflowElement): el is FrameElement {
  return findDefinition(el.type)?.capabilities.frame === true;
}

/**
 * True for elements that display a file from `document.files`
 * (`capabilities.file`). Narrows to `ImageElement` for its `fileId`.
 *
 * Why a capability rather than the structural test `'fileId' in el`: every
 * caller reads `fileId` straight away, so the structural test would ask the
 * right question. But it would not match the `type === 'image'` comparisons it
 * replaced on every input. The loader rebuilds each element field by field,
 * while system-clipboard paste takes elements verbatim. A pasted rectangle
 * carrying a stray `fileId` would then be decoded, copied with a file, and
 * validated. A registry lookup cannot see stray fields.
 */
export function hasFile(el: MindflowElement): el is ImageElement {
  return findDefinition(el.type)?.capabilities.file === true;
}

export function drawElement(el: MindflowElement, render: RenderContext): void {
  getDefinition(el.type).draw(el as never, render);
}

export function hitTestElement(el: MindflowElement, local: Point, tolerance: number): boolean {
  return getDefinition(el.type).hitTest(el as never, local, tolerance);
}

/**
 * Where an element's label sits, in its LOCAL frame.
 *
 * The single reader of {@link ElementDefinition.labelBox}, so the canvas, the
 * DOM editor and the SVG exporter cannot disagree about the default.
 */
export function labelBoxOf(el: MindflowElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const box = getDefinition(el.type).labelBox?.(el as never);
  return box ?? { x: 0, y: 0, width: el.width, height: el.height };
}

/**
 * Test-only. Vitest runs each file in a fresh module registry, but a suite that
 * imports the shape barrel twice would otherwise trip the duplicate check.
 */
export function __resetRegistry(): void {
  registry.clear();
}
