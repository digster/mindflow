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
  MindflowDocument,
  MindflowElement,
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
   * Where a ray from the element's centre towards `localDirection` crosses its
   * outline, in the LOCAL frame. Optional; omitting it means "my outline is my
   * bounding rectangle", which is right for most shapes.
   *
   * This exists so auto-anchored connectors can attach to a shape's real edge
   * rather than its bounding box. It was previously a `type === 'ellipse'`
   * branch inside `geometry.ts` — the one place outside `render/shapes/` that
   * broke the no-branching-on-type rule, and the reason adding a diamond would
   * otherwise have had to break it a second time.
   *
   * `localDirection` is a vector from the centre, not a point. Implementations
   * return the crossing point in local coordinates; the caller handles rotation
   * and the connector gap.
   *
   * Published in `docs/07-rendering.md`: an external renderer needs this to
   * reproduce a bound connector, so a new implementation is a format change.
   */
  outlineIntersect?(el: T, localDirection: Point): Point;

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

export function drawElement(el: MindflowElement, render: RenderContext): void {
  getDefinition(el.type).draw(el as never, render);
}

export function hitTestElement(el: MindflowElement, local: Point, tolerance: number): boolean {
  return getDefinition(el.type).hitTest(el as never, local, tolerance);
}

/**
 * Test-only. Vitest runs each file in a fresh module registry, but a suite that
 * imports the shape barrel twice would otherwise trip the duplicate check.
 */
export function __resetRegistry(): void {
  registry.clear();
}
