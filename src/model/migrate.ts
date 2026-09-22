/**
 * Schema migrations.
 *
 * A documented file format is a promise that files written today will still open
 * tomorrow. This module is how that promise is kept: every breaking change to
 * the format ships with a transform from the previous version, and loading walks
 * the chain from a document's declared version up to {@link CURRENT_SCHEMA_VERSION}.
 *
 * Every version up to 1.4.0 was purely additive, so those entries are identity
 * transforms. They are not omitted: `needsMigration` triggers on any version
 * inequality, so a missing step would make every older board load with a "no
 * migration is available" warning, which reads as data loss. 1.5.0 is the first
 * to transform anything — it retired four element types.
 *
 * ---------------------------------------------------------------------------
 * Adding a migration
 * ---------------------------------------------------------------------------
 *   1. Bump `CURRENT_SCHEMA_VERSION` in `types.ts`.
 *   2. Add a `MIGRATIONS` entry keyed by the version being migrated FROM.
 *   3. Copy `docs/schema/mindflow-<old>.schema.json` and edit the new copy —
 *      published schemas are immutable, since files reference them by URL.
 *   4. Record the change in `docs/CHANGELOG.md` with a rationale.
 *   5. Add a fixture in `test/unit/document.test.ts` proving the old file loads.
 *
 * Migrations receive and return plain unvalidated objects, never typed elements.
 * They run before normalisation, so each one sees the document exactly as its
 * own version wrote it — not a hybrid already partly patched with current
 * defaults. Typing them against the *current* interfaces would be actively
 * wrong, because those interfaces describe a shape the old file does not have.
 */

import type { LoadWarning } from './document.ts';
import { CURRENT_SCHEMA_VERSION } from './types.ts';

/** A raw, unvalidated document at some schema version. */
export type RawDocument = Record<string, unknown>;

export interface Migration {
  /** Version this migration produces. */
  to: string;
  /** Short human explanation, surfaced to the user as a load warning. */
  description: string;
  migrate(document: RawDocument): RawDocument;
}

/**
 * Keyed by the version being migrated FROM.
 *
 * Example of the shape a future entry takes:
 *
 *   '1.0.0': {
 *     to: '1.1.0',
 *     description: 'Split `text.align` into `textAlign` and `verticalAlign`.',
 *     migrate(doc) { ... return doc; },
 *   },
 */
const MIGRATIONS: Record<string, Migration> = {
  /**
   * Identity, and deliberately not omitted.
   *
   * 1.0.0 → 1.1.0 is purely additive: it introduces the `diamond` type and
   * starts writing non-zero `style.roughness`, neither of which changes an
   * existing file. Nothing needs transforming — but `needsMigration` triggers on
   * *any* version inequality, so leaving this out would make every 1.0.0 board
   * ever saved load with a "no migration is available" warning. An identity step
   * turns that into the ordinary "upgraded this board" note.
   */
  '1.0.0': {
    to: '1.1.0',
    description: 'Additive: the `diamond` element type, and `style.roughness` is now rendered.',
    migrate: (document) => document,
  },

  /**
   * Also identity. 1.2.0 adds the `frame` type and the `frameId` field, and a
   * 1.1.0 file simply has no frames — the loader defaults `frameId` to null.
   */
  '1.1.0': {
    to: '1.2.0',
    description: 'Additive: the `frame` element type and `frameId` containment.',
    migrate: (document) => document,
  },

  /**
   * Also identity. 1.3.0 adds the `table` type and nothing else — no existing
   * field changes shape, and a 1.2.0 file simply contains no tables.
   */
  '1.2.0': {
    to: '1.3.0',
    description: 'Additive: the `table` element type.',
    migrate: (document) => document,
  },

  /**
   * Also identity. 1.4.0 adds thirteen element types — five flat polygons and
   * eight solids — and not one field on any existing type. A 1.3.0 file simply
   * contains none of them.
   */
  '1.3.0': {
    to: '1.4.0',
    description: 'Additive: the flat polygon and solid element types.',
    migrate: (document) => document,
  },

  /**
   * The first migration that changes anything. 1.5.0 retired four of the
   * solids 1.4.0 introduced, and a board holding one must not lose it: an
   * unrecognised type is preserved but not drawn, so without this step the
   * shape would silently vanish from the canvas while lingering in the file.
   *
   * Each becomes the flat shape that draws its silhouette — see
   * {@link RETIRED_SOLIDS}. Everything else about the element (id, box, angle,
   * z-order, style, label, group and frame membership, `meta`) is carried over
   * untouched, so connectors bound to it stay bound.
   */
  '1.4.0': {
    to: '1.5.0',
    description:
      'Retired the `sphere`, `prism`, `torus` and `capsule` types; any on this board ' +
      'became the flat shape of their outline.',
    migrate(document) {
      if (!Array.isArray(document.elements)) return document;
      return { ...document, elements: document.elements.map(retireSolid) };
    },
  },
};

// ---------------------------------------------------------------------------
// 1.4.0 → 1.5.0
// ---------------------------------------------------------------------------

type RawElement = Record<string, unknown>;

function isRawElement(value: unknown): value is RawElement {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What each type retired in 1.5.0 becomes: the flat shape whose outline is the
 * solid's silhouette, so the board keeps its layout and loses only the shading.
 *
 *   sphere   the ellipse inscribed in the box — exactly its old silhouette
 *   torus    the same ellipse; the hole is the one thing that cannot survive
 *   prism    a triangle, apex top-centre — the prism seen face-on
 *   capsule  a rectangle whose corner radius is half its shorter side, which
 *            is precisely a stadium: the old silhouette, exactly
 *
 * Published in `docs/CHANGELOG.md` so another reader of the format can apply
 * the same conversion.
 */
const RETIRED_SOLIDS: Record<string, (element: RawElement) => RawElement> = {
  sphere: (element) => ({ ...element, type: 'ellipse' }),
  torus: (element) => ({ ...element, type: 'ellipse' }),
  prism: (element) => ({ ...element, type: 'triangle' }),
  capsule: (element) => {
    const radius = pillRadius(element.width, element.height);
    // A box too malformed to size a pill from is left to the loader, which
    // repairs it and falls back to the rectangle's default radius.
    return radius === null
      ? { ...element, type: 'rectangle' }
      : { ...element, type: 'rectangle', cornerRadius: radius };
  },
};

function retireSolid(element: unknown): unknown {
  if (!isRawElement(element) || typeof element.type !== 'string') return element;
  const convert = RETIRED_SOLIDS[element.type];
  if (!convert) return element;

  const converted = convert(element);
  // A solid never drew its `roughness` — it has no hand-drawn form — but every
  // shape it can become does. Carrying a stored value across would make the
  // shape turn sketchy the moment the board is upgraded, so it is zeroed to
  // keep the drawing as it was. A missing or malformed style is left for the
  // loader, whose default roughness is already 0.
  return isRawElement(converted.style)
    ? { ...converted, style: { ...converted.style, roughness: 0 } }
    : converted;
}

/** Half the box's shorter side, or `null` when the raw box cannot be read. */
function pillRadius(width: unknown, height: unknown): number | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return Math.min(w, h) / 2;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/** Parses `major.minor.patch`, tolerating junk by treating missing parts as 0. */
export function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns <0, 0 or >0 in the manner of a comparator. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function needsMigration(version: string): boolean {
  return compareVersions(version, CURRENT_SCHEMA_VERSION) !== 0;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  document: RawDocument;
  warnings: LoadWarning[];
}

/**
 * Walks the migration chain from `fromVersion` to the current version.
 *
 * Three cases are handled deliberately differently:
 *
 *   OLDER, chain complete    Apply each step in turn. Silent success.
 *   OLDER, chain incomplete  A gap in `MIGRATIONS` means we cannot upgrade. Warn
 *                            loudly and load as-is; the normaliser's leniency
 *                            usually still produces something usable.
 *   NEWER                    The file was written by a future build. We cannot
 *                            know what changed, so we warn and attempt the load
 *                            anyway. Unknown element types survive via
 *                            `LoadResult.preserved`, so a save-after-open does
 *                            not destroy data the reader did not understand.
 */
export function migrateDocument(document: RawDocument, fromVersion: string): MigrationResult {
  const warnings: LoadWarning[] = [];

  if (compareVersions(fromVersion, CURRENT_SCHEMA_VERSION) > 0) {
    warnings.push({
      level: 'warning',
      path: 'schemaVersion',
      message:
        `This board was created with schema ${fromVersion}, which is newer than this build ` +
        `understands (${CURRENT_SCHEMA_VERSION}). It will open, but anything this version ` +
        `does not recognise is preserved rather than displayed.`,
    });
    return { document, warnings };
  }

  let current = document;
  let version = fromVersion;
  const applied: string[] = [];

  // Bounded loop: a malformed MIGRATIONS table that cycles would otherwise hang
  // the app on load. The bound is generous but finite.
  for (let step = 0; step < 100; step++) {
    if (compareVersions(version, CURRENT_SCHEMA_VERSION) >= 0) break;

    const migration = MIGRATIONS[version];
    if (!migration) {
      warnings.push({
        level: 'warning',
        path: 'schemaVersion',
        message:
          `No migration is available from schema ${version} to ${CURRENT_SCHEMA_VERSION}. ` +
          `The board will be loaded as-is and may be missing or misinterpret some data.`,
      });
      break;
    }

    current = migration.migrate(current);
    applied.push(`${version} → ${migration.to} (${migration.description})`);
    version = migration.to;
  }

  if (applied.length > 0) {
    warnings.push({
      level: 'info',
      path: 'schemaVersion',
      message: `Upgraded this board from schema ${fromVersion}: ${applied.join('; ')}`,
    });
  }

  current.schemaVersion = CURRENT_SCHEMA_VERSION;
  return { document: current, warnings };
}

/** Exposed for the migration tests. */
export function registeredMigrations(): Record<string, Migration> {
  return MIGRATIONS;
}
