/**
 * Schema migrations.
 *
 * A documented file format is a promise that files written today will still open
 * tomorrow. This module is how that promise is kept: every breaking change to
 * the format ships with a transform from the previous version, and loading walks
 * the chain from a document's declared version up to {@link CURRENT_SCHEMA_VERSION}.
 *
 * Every published version so far has been purely additive, so each entry below
 * is an identity transform. They are not omitted: `needsMigration` triggers on
 * any version inequality, so a missing step would make every older board load
 * with a "no migration is available" warning, which reads as data loss.
 *
 * ---------------------------------------------------------------------------
 * Adding a migration
 * ---------------------------------------------------------------------------
 *   1. Bump `CURRENT_SCHEMA_VERSION` in `types.ts`.
 *   2. Add a `MIGRATIONS` entry keyed by the version being migrated FROM.
 *   3. Copy `docs/schema/mindflow-<old>.schema.json` and edit the new copy —
 *      published schemas are immutable, since files reference them by URL.
 *   4. Record the change in `docs/CHANGELOG.md` with a rationale.
 *   5. Add a fixture in `test/unit/migrate.test.ts` proving the old file loads.
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
};

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
