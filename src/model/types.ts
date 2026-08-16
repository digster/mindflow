/**
 * MindFlow document model — the canonical TypeScript description of the
 * `.mindflow.json` save format.
 *
 * ============================================================================
 * THIS FILE IS PART OF A PUBLISHED CONTRACT.
 * ============================================================================
 * The save format is specified in three places that must always agree:
 *
 *   1. `docs/02-document-format.md` + `docs/03-elements.md`  — prose, for humans
 *   2. `docs/schema/mindflow-1.0.0.schema.json`              — JSON Schema, for machines
 *   3. this file                                             — types, for the app
 *
 * `test/unit/contract.test.ts` fails the build if they drift apart. If you
 * change anything here, change the other two in the same commit.
 *
 * ---------------------------------------------------------------------------
 * Conventions that apply to the whole model
 * ---------------------------------------------------------------------------
 * COORDINATES  All geometry is in *scene units*. One scene unit equals one CSS
 *              pixel at `viewport.zoom === 1`. The scene is unbounded in every
 *              direction and its origin (0,0) is arbitrary — it is simply where
 *              a fresh board starts. +x is right, +y is DOWN (screen convention,
 *              not mathematical convention).
 *
 * ANGLES       Degrees, not radians. Clockwise-positive. Rotation always happens
 *              about the centre of the element's own unrotated bounding box.
 *              Degrees are used deliberately: a human or a language model
 *              reading raw JSON can reason about `"angle": 45` instantly, and
 *              cannot do the same for `0.7853981633974483`.
 *
 * COLORS       CSS color strings. MindFlow itself always writes `#rrggbb` or
 *              `#rrggbbaa`, or the exact keyword `"transparent"`. Readers should
 *              accept any valid CSS color; writers should prefer hex.
 *
 * NO INHERITANCE  Every element carries its fully resolved style. Nothing is
 *              inherited from a parent, a theme, or a document default. This
 *              makes any single element interpretable in isolation, which is the
 *              entire point of the format.
 */

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/**
 * A point in scene space, serialised as a two- or three-element tuple.
 *
 * Tuples rather than `{x, y}` objects: a freehand stroke can hold hundreds of
 * points, and the object form roughly triples file size while making the JSON
 * far harder to skim. This follows the same reasoning as GeoJSON positions.
 *
 * The optional third component is stylus pressure in the range 0..1.
 */
export type PointTuple = [x: number, y: number] | [x: number, y: number, pressure: number];

/** An in-memory point. Never serialised in this form — see {@link PointTuple}. */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned bounding box, expressed as two corners. */
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The window onto the scene.
 *
 * `x`/`y` are the scene coordinates displayed at the top-left of the canvas, and
 * `zoom` is the scale factor. The conversions, which are the only two formulas
 * an external tool needs in order to place anything on screen, are:
 *
 *     screen = (scene - viewport.xy) * zoom
 *     scene  = screen / zoom + viewport.xy
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Identifiers are opaque strings. MindFlow generates them as a short prefix plus
 * 10 URL-safe random characters (e.g. `el_V1StGXR8Z5`), but readers must treat
 * them as arbitrary: never parse an ID, never infer order or type from one, and
 * never assume the prefix is present.
 *
 * IDs are unique within a single document, not globally.
 */
export type ElementId = string;
export type GroupId = string;
export type FileId = string;
export type BoardId = string;

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type StrokeStyle = (typeof STROKE_STYLES)[number];

export const FILL_STYLES = ['solid', 'none'] as const;
export type FillStyle = (typeof FILL_STYLES)[number];

export const FONT_FAMILIES = ['sans', 'serif', 'mono', 'hand'] as const;
/**
 * Font families are logical names, not concrete typefaces. Each maps to a CSS
 * font stack defined in `docs/07-rendering.md`. Storing a logical name keeps
 * boards portable: a document authored on a machine without a given font still
 * renders sensibly everywhere else.
 */
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type VerticalAlign = (typeof VERTICAL_ALIGNS)[number];

/** The visual style shared by every element type. */
export interface ElementStyle {
  /** Outline color, or `"transparent"` for no outline. */
  stroke: string;
  /** Outline width in scene units. `0` also means no outline. */
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  /** Interior color. Ignored entirely when `fillStyle` is `"none"`. */
  fill: string;
  fillStyle: FillStyle;
  /**
   * Hand-drawn jitter amount, 0..2. `0` renders clean geometric shapes.
   *
   * Reserved but unwritten in 1.0.0; rendered as of 1.1.0. No seed accompanies
   * it — the jitter is seeded from the element's `id`, which is already stored
   * and already stable across a round trip. The full algorithm is published in
   * `docs/07-rendering.md`; readers that cannot reproduce it must still accept
   * and preserve the value, and may render everything as `0`.
   */
  roughness: number;
}

/**
 * Text rendered inside a shape (as opposed to a free-standing `text` element).
 *
 * A label is positioned by the host element's geometry and rotates with it, so
 * it has no coordinates of its own. Wrapping is specified in
 * `docs/07-rendering.md` — external renderers need that algorithm to reproduce
 * line breaks exactly.
 */
export interface ElementLabel {
  text: string;
  fontFamily: FontFamily;
  /** Em size in scene units. */
  fontSize: number;
  /** CSS numeric weight, 100–900. */
  fontWeight: number;
  /** Line advance as a multiple of `fontSize`. */
  lineHeight: number;
  color: string;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  /** Inset between the host element's box and the text, in scene units. */
  padding: number;
}

// ---------------------------------------------------------------------------
// Element base
// ---------------------------------------------------------------------------

export const ELEMENT_TYPES = [
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'draw',
  'text',
  'sticky',
  'image',
  'diamond',
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/** Fields carried by every element regardless of type. */
export interface BaseElement {
  id: ElementId;
  type: ElementType;

  /**
   * Top-left corner of the element's UNROTATED bounding box, in scene units.
   * Note the subtlety: this is not the visually top-left corner once `angle` is
   * non-zero. To find where the element actually sits on screen, rotate the box
   * about its centre — see `docs/04-coordinates.md`.
   */
  x: number;
  y: number;

  /**
   * Size of the unrotated bounding box, in scene units. Both are always
   * strictly positive; a "flipped" element is expressed by mirrored geometry or
   * a 180° angle, never by a negative dimension. This invariant means readers
   * never have to normalise a box before using it.
   */
  width: number;
  height: number;

  /** Rotation in degrees, clockwise, about the box centre. Normalised to [0, 360). */
  angle: number;

  /**
   * Paint order. Higher values paint later, and therefore on top. Values are
   * fractional by design: inserting an element between two others assigns the
   * midpoint of their indices, so no other element has to be renumbered. That
   * keeps edits local, which in turn keeps undo entries and git diffs small.
   *
   * Ties are broken by array position, but MindFlow never writes ties.
   */
  zIndex: number;

  /** 0 (invisible) .. 1 (opaque). Applies to the whole element, stroke and fill together. */
  opacity: number;

  /** A locked element renders normally but cannot be selected or edited in the UI. */
  locked: boolean;

  /** A hidden element is not rendered, not exported, and not hit-testable. */
  visible: boolean;

  /**
   * Grouping is flat and by reference: every element sharing a `groupId` moves,
   * rotates and deletes as a unit. There is no nesting and no group object —
   * a group exists precisely as long as two or more elements name it.
   *
   * Modelling groups this way (rather than as a tree) keeps the element array
   * flat and order-independent, which makes documents far easier to diff, query
   * and generate programmatically.
   */
  groupId: GroupId | null;

  style: ElementStyle;

  /** Optional text drawn inside this element. `null` when the element has no label. */
  label: ElementLabel | null;

  /**
   * Free-form namespace reserved for tools outside MindFlow. MindFlow never
   * reads, writes, interprets or validates the contents, but always preserves
   * it across a load/save round trip. Use it to attach your own annotations
   * without risking a collision with a future MindFlow field.
   */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Concrete element types
// ---------------------------------------------------------------------------

export interface RectangleElement extends BaseElement {
  type: 'rectangle';
  /**
   * Corner radius in scene units. Clamped at render time to half the shorter
   * side, so an arbitrarily large value yields a stadium shape rather than
   * invalid geometry.
   */
  cornerRadius: number;
}

export interface EllipseElement extends BaseElement {
  type: 'ellipse';
}

/**
 * A rhombus inscribed in the element's box, for flowchart decision nodes.
 *
 * Carries no fields of its own — the four vertices are the midpoints of the
 * box's edges, so the box is the entire geometry.
 */
export interface DiamondElement extends BaseElement {
  type: 'diamond';
}

export const ARROWHEADS = ['none', 'arrow', 'triangle', 'dot', 'bar'] as const;
export type Arrowhead = (typeof ARROWHEADS)[number];

export const CURVE_STYLES = ['straight', 'curved', 'elbow'] as const;
export type CurveStyle = (typeof CURVE_STYLES)[number];

/**
 * How one end of a connector attaches to another element.
 *
 * `mode: "fixed"` pins the endpoint to a specific spot on the target, given in
 * normalised coordinates on the target's local unrotated box: `u` runs 0 (left)
 * to 1 (right), `v` runs 0 (top) to 1 (bottom). The point is then transformed by
 * the target's rotation, so the connector follows the shape as it turns.
 *
 * `mode: "auto"` recomputes the attachment point every time either element
 * moves, aiming at the target's centre and stopping where the ray crosses the
 * target's outline. The exact algorithm is specified in `docs/07-rendering.md`,
 * and it must be, or a file with an auto binding cannot be rendered correctly by
 * anything except MindFlow itself.
 */
export interface Binding {
  elementId: ElementId;
  anchor:
    | { mode: 'auto' }
    | { mode: 'fixed'; u: number; v: number };
  /** Clearance left between the target's outline and the connector tip, in scene units. */
  gap: number;
}

/**
 * A line or an arrow. Both share one implementation and differ only in their
 * default arrowheads — an `arrow` with both arrowheads set to `"none"` is
 * visually identical to a `line`, and that is intentional.
 */
export interface LinearElement extends BaseElement {
  type: 'line' | 'arrow';
  /**
   * Vertices RELATIVE to the element's `x`/`y`, so translating the element never
   * touches this array. There are always at least two. The first and last are
   * the endpoints that bindings apply to.
   */
  points: PointTuple[];
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
  curve: CurveStyle;
  /** `null` when the endpoint is free-floating. */
  startBinding: Binding | null;
  endBinding: Binding | null;
}

export interface DrawElement extends BaseElement {
  type: 'draw';
  /** Freehand stroke path, relative to `x`/`y`, in capture order. */
  points: PointTuple[];
  /**
   * When true, the third component of each point is meaningful and the stroke is
   * rendered with a variable width. When false, any pressure values present are
   * ignored (but still preserved on save).
   */
  pressureSensitive: boolean;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  /**
   * When true, `width` is a derived value that MindFlow recomputes from the text
   * on every edit, and the text never wraps on its own. When false, `width` is
   * authoritative and the text wraps to fit it.
   *
   * Readers that cannot measure text should trust the stored `width`/`height`
   * regardless of this flag; they are always written out correctly.
   */
  autoWidth: boolean;
}

/**
 * A sticky note.
 *
 * Deliberately its own type rather than a rectangle carrying a label. The two
 * would render almost identically, but a distinct type preserves the author's
 * *intent* in the file — a program reading the board can answer "what are the
 * sticky notes on this board?" without guessing from styling heuristics. That
 * semantic legibility is worth one extra type.
 */
export interface StickyElement extends BaseElement {
  type: 'sticky';
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  padding: number;
}

export const OBJECT_FITS = ['fill', 'contain', 'cover'] as const;
export type ObjectFit = (typeof OBJECT_FITS)[number];

export interface ImageElement extends BaseElement {
  type: 'image';
  /** Key into the document's `files` map. Must resolve; a dangling ref is invalid. */
  fileId: FileId;
  /** Intrinsic pixel dimensions of the source image, used to preserve aspect ratio. */
  naturalWidth: number;
  naturalHeight: number;
  objectFit: ObjectFit;
}

/** Discriminated union of every element type. Narrow on `.type`. */
export type MindflowElement =
  | RectangleElement
  | EllipseElement
  | LinearElement
  | DrawElement
  | TextElement
  | StickyElement
  | ImageElement
  | DiamondElement;

/** Elements whose geometry is a point list rather than a box. */
export type PathElement = LinearElement | DrawElement;

/** Elements that own text directly (as opposed to via `label`). */
export type TextualElement = TextElement | StickyElement;

// ---------------------------------------------------------------------------
// Embedded binary assets
// ---------------------------------------------------------------------------

/**
 * An embedded binary asset, almost always an image.
 *
 * Assets live in a top-level map instead of inline on the element for two
 * reasons: identical images pasted twice are stored once, and the `elements`
 * array stays readable rather than being interrupted by multi-megabyte base64
 * blobs. The map key is the SHA-256 of the decoded bytes, which is what makes
 * the deduplication automatic and verifiable.
 */
export interface EmbeddedFile {
  /** MIME type of the payload, e.g. `image/png`. */
  mimeType: string;
  /** The asset as an RFC 2397 data URI, including the `data:` prefix. */
  dataUri: string;
  /** Decoded size in bytes, so a reader can budget before decoding. */
  byteLength: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface CanvasSettings {
  /** Board background color, painted beneath every element. */
  background: string;
  grid: {
    visible: boolean;
    /** Spacing in scene units. */
    size: number;
    /** Whether new and moved elements snap to the grid. */
    snap: boolean;
  };
}

export interface DocumentMeta {
  name: string;
  /** ISO 8601 UTC, e.g. `2026-08-14T10:42:11.000Z`. */
  createdAt: string;
  updatedAt: string;
  /** Which program wrote this file. Informational; never affects parsing. */
  app: {
    name: string;
    version: string;
  };
}

/**
 * A complete MindFlow board — the exact shape of a `.mindflow.json` file.
 */
export interface MindflowDocument {
  /**
   * URL of the JSON Schema this document conforms to. Present so that editors
   * and validators can find the schema without configuration.
   */
  $schema?: string;
  /** Format discriminator. Always the literal `"mindflow.board"`. */
  type: 'mindflow.board';
  /** Semver of the *format*, not of the app. See `docs/CHANGELOG.md`. */
  schemaVersion: string;
  id: BoardId;
  meta: DocumentMeta;
  canvas: CanvasSettings;
  /**
   * Where the camera was when the board was saved. Purely a convenience so a
   * board reopens where you left it; it carries no semantic weight and readers
   * are free to ignore it entirely.
   */
  viewport: Viewport;
  /**
   * All elements, conventionally sorted ascending by `zIndex`. Readers should
   * sort defensively rather than rely on array order — `zIndex` is the truth.
   */
  elements: MindflowElement[];
  /** Embedded assets, keyed by SHA-256 content hash. */
  files: Record<FileId, EmbeddedFile>;
}

/** The schema version this build reads and writes natively. */
export const CURRENT_SCHEMA_VERSION = '1.1.0';

/** Canonical filename extension for a board. */
export const FILE_EXTENSION = '.mindflow.json';

/** MIME type used for Drive uploads and download links. */
export const FILE_MIME_TYPE = 'application/json';
