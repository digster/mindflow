/**
 * Contract enforcement.
 *
 * The save format is specified in three places that must always agree:
 *
 *   1. `docs/*.md`                                — prose, for humans
 *   2. `docs/schema/mindflow-*.schema.json`       — JSON Schema, for machines
 *   3. `src/model/types.ts` + the element registry — types, for the app
 *
 * Prose cannot be checked automatically, but the other two can — and so can the
 * relationship between them and the running code. This file is what stops the
 * documentation quietly rotting into fiction.
 *
 * If you are here because this test failed: you changed one of the three and not
 * the others. Fix the mismatch rather than the assertion.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import '../../src/render/shapes/index.ts';
import { allDefinitions, registeredTypes } from '../../src/model/registry.ts';
import { CURRENT_SCHEMA_VERSION, ELEMENT_TYPES } from '../../src/model/types.ts';
import { SCHEMA_URL } from '../../src/model/defaults.ts';
import { registeredMigrations } from '../../src/model/migrate.ts';
import { loadDocument, serializeDocument } from '../../src/model/document.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(ROOT, 'docs');
const SCHEMA_PATH = join(DOCS, 'schema', `mindflow-${CURRENT_SCHEMA_VERSION}.schema.json`);
const EXAMPLES_DIR = join(DOCS, 'schema', 'examples');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

function createValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** The element `type` values the schema's discriminator enumerates. */
function schemaElementTypes(): string[] {
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const base = defs.baseElement as { properties: { type: { enum: string[] } } };
  return [...base.properties.type.enum].sort();
}

describe('registry ↔ schema', () => {
  it('the schema enumerates exactly the types the registry implements', () => {
    // TypeScript types vanish at runtime and cannot be checked this way. The
    // registry can — which is precisely why the registry exists as a runtime
    // structure rather than a type-level union alone.
    expect(schemaElementTypes()).toEqual(registeredTypes());
  });

  it('ELEMENT_TYPES matches the registry', () => {
    expect([...ELEMENT_TYPES].sort()).toEqual(registeredTypes());
  });

  it('every registered type has a $defs entry reachable from the element union', () => {
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    const union = (defs.element as { oneOf: { $ref: string }[] }).oneOf;
    const referenced = union.map((entry) => entry.$ref.replace('#/$defs/', ''));

    // Collect every `type` const/enum reachable from the union members.
    const covered = new Set<string>();
    for (const name of referenced) {
      const def = defs[name] as { allOf?: Record<string, unknown>[] } | undefined;
      expect(def, `$defs.${name} is referenced by the element union but does not exist`).toBeDefined();

      for (const branch of def?.allOf ?? []) {
        const properties = branch.properties as { type?: { const?: string; enum?: string[] } } | undefined;
        if (properties?.type?.const) covered.add(properties.type.const);
        for (const value of properties?.type?.enum ?? []) covered.add(value);
      }
    }

    expect([...covered].sort()).toEqual(registeredTypes());
  });
});

describe('registry ↔ documentation', () => {
  it('every registered type has a section in docs/03-elements.md', () => {
    const markdown = readFileSync(join(DOCS, '03-elements.md'), 'utf8');
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]?.trim());

    for (const type of registeredTypes()) {
      expect(headings, `docs/03-elements.md is missing a "## ${type}" section`).toContain(type);
    }
  });

  it('every registered type appears in the capability matrix', () => {
    const markdown = readFileSync(join(DOCS, '03-elements.md'), 'utf8');
    for (const type of registeredTypes()) {
      expect(
        markdown.includes(`| \`${type}\` |`),
        `docs/03-elements.md capability matrix is missing a row for "${type}"`,
      ).toBe(true);
    }
  });

  /**
   * The reverse of the two checks above. They catch a type added without
   * documentation; this catches a type REMOVED without it — which is the easier
   * mistake, because nothing else fails. 1.5.0 retired four solids, and their
   * rows would otherwise have gone on advertising types the schema rejects.
   */
  it('the capability matrix lists no type the registry lacks', () => {
    const markdown = readFileSync(join(DOCS, '03-elements.md'), 'utf8');
    const start = markdown.indexOf('## Capability matrix');
    const end = markdown.indexOf('\n## ', start + 1);
    const matrix = markdown.slice(start, end);
    const rows = [...matrix.matchAll(/^\| `([a-z]+)` \|/gm)].map((match) => match[1] as string);

    expect(rows.length).toBeGreaterThan(0);
    for (const type of rows) {
      expect(
        registeredTypes(),
        `docs/03-elements.md documents "${type}", which is not a registered type`,
      ).toContain(type);
    }
  });

  it('the schema version is recorded in the changelog', () => {
    const changelog = readFileSync(join(DOCS, 'CHANGELOG.md'), 'utf8');
    expect(
      changelog.includes(`## ${CURRENT_SCHEMA_VERSION}`),
      `docs/CHANGELOG.md has no "## ${CURRENT_SCHEMA_VERSION}" entry`,
    ).toBe(true);
  });

  /**
   * `SCHEMA_URL` is stamped into every board MindFlow saves. It was a
   * hand-written literal until 1.1.0, with nothing tying it to the version
   * constant — so a bump that forgot to update it would have shipped files
   * pointing at the wrong schema document, silently and permanently.
   */
  it('the advertised $schema URL names the current schema, and that file exists', () => {
    expect(SCHEMA_URL).toContain(`mindflow-${CURRENT_SCHEMA_VERSION}.schema.json`);
    expect(
      existsSync(SCHEMA_PATH),
      `${SCHEMA_URL} names a schema that is not published in docs/schema/`,
    ).toBe(true);
  });

  /**
   * A version bump with no migration entry is not an error — but it makes every
   * previously saved file load with a "no migration is available" warning, which
   * reads as data loss to anyone who sees it.
   */
  it('every published version can be migrated to the current one', () => {
    const changelog = readFileSync(join(DOCS, 'CHANGELOG.md'), 'utf8');
    const published = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((match) => match[1] as string);
    const migrations = registeredMigrations();

    for (const version of published) {
      if (version === CURRENT_SCHEMA_VERSION) continue;
      expect(
        migrations[version],
        `no migration from ${version}; every 1.0.0-era board would load with a warning`,
      ).toBeDefined();
    }
  });

  it('every definition declares a complete capability set', () => {
    const required = ['label', 'path', 'text', 'resizable', 'rotatable', 'bindable', 'connector'];
    for (const definition of allDefinitions()) {
      for (const flag of required) {
        expect(
          definition.capabilities,
          `${definition.type} is missing the "${flag}" capability`,
        ).toHaveProperty(flag);
      }
    }
  });

  it('connectors are never bindable', () => {
    // Binding arrows to arrows creates dependency chains with no stable layout
    // fixed point. Enforced here so a future shape cannot quietly opt in. It is
    // keyed on the capability rather than on type names, so a new connector
    // type is covered as soon as it declares itself one.
    for (const definition of allDefinitions()) {
      if (definition.capabilities.connector) {
        expect(definition.capabilities.bindable, `${definition.type} must not be bindable`).toBe(false);
      }
    }
  });

  /**
   * `isConnector` and `isPathElement` narrow to `LinearElement` and
   * `PathElement` because of a flag, and TypeScript cannot check that a flag
   * matches the fields. This test does: a definition sets each flag exactly
   * when what it creates has the fields the narrowing promises. In the other
   * direction, it also catches the flag being dropped from `linear.ts`, which
   * would quietly stop arrows re-routing when their shapes move.
   */
  it('the connector and path flags match the fields they promise', () => {
    for (const definition of allDefinitions()) {
      const element = definition.create({ x: 0, y: 0, width: 120, height: 80, zIndex: 0 }) as unknown as
        Record<string, unknown>;
      const { connector, path } = definition.capabilities;

      expect(
        Array.isArray(element.points),
        `${definition.type}: path is ${path}, so points must be ${path ? 'present' : 'absent'}`,
      ).toBe(path);
      expect(
        'startBinding' in element && 'endBinding' in element,
        `${definition.type}: connector is ${connector}, so the binding fields must be ${connector ? 'present' : 'absent'}`,
      ).toBe(connector);
    }
  });
});

describe('migrations', () => {
  /**
   * An example board is written at the version that introduced what it shows,
   * so a type that is later retired cannot stay in one — it would stop
   * validating. This is the fixture that replaces it: an old board holding every
   * retired type must still come out the other side as a valid current board.
   */
  it('a 1.4.0 board holding the retired solids migrates to a valid board', () => {
    const retired = ['sphere', 'prism', 'torus', 'capsule'].map((type, index) => ({
      id: `el_retired${index}`,
      type,
      x: index * 150,
      y: 0,
      width: 120,
      height: 90,
      style: { stroke: '#1e1e1e', fill: '#ffffff', fillStyle: 'solid', roughness: 1 },
    }));
    const board = JSON.stringify({ type: 'mindflow.board', schemaVersion: '1.4.0', elements: retired });

    const output = JSON.parse(serializeDocument(loadDocument(board).document)) as {
      elements: { type: string }[];
    };
    const validate = createValidator();
    const valid = validate(output);
    if (!valid) {
      const details = (validate.errors ?? [])
        .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
        .join('\n');
      throw new Error(`the migrated board does not validate:\n${details}`);
    }
    expect(output.elements).toHaveLength(retired.length);
  });
});

describe('documented examples', () => {
  const files = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith('.json'));

  it('there is at least one example', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const raw = readFileSync(join(EXAMPLES_DIR, file), 'utf8');

      it('validates against the published JSON Schema', () => {
        const validate = createValidator();
        const valid = validate(JSON.parse(raw));
        if (!valid) {
          const details = (validate.errors ?? [])
            .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
            .join('\n');
          throw new Error(`${file} does not validate:\n${details}`);
        }
        expect(valid).toBe(true);
      });

      it('loads without errors', () => {
        const { warnings } = loadDocument(raw);
        const errors = warnings.filter((warning) => warning.level === 'error');
        expect(errors, `${file} produced load errors: ${JSON.stringify(errors, null, 2)}`).toEqual([]);
      });

      it('round-trips: load → save → load is stable', () => {
        // Normalising once may legitimately change the input (filling defaults,
        // rounding). Normalising a SECOND time must change nothing — that is what
        // makes save/load idempotent, and it is the property the format needs.
        const first = serializeDocument(loadDocument(raw).document);
        const second = serializeDocument(loadDocument(first).document);

        expect(stripTimestamps(second)).toEqual(stripTimestamps(first));
      });

      it('the re-serialised form still validates', () => {
        const validate = createValidator();
        const output = serializeDocument(loadDocument(raw).document);
        const valid = validate(JSON.parse(output));
        if (!valid) {
          const details = (validate.errors ?? [])
            .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
            .join('\n');
          throw new Error(`${file} does not validate after a round trip:\n${details}`);
        }
        expect(valid).toBe(true);
      });

      it('preserves third-party `meta` verbatim', () => {
        const original = JSON.parse(raw) as { elements: { id: string; meta?: unknown }[] };
        const withMeta = original.elements.filter(
          (element) => element.meta && Object.keys(element.meta).length > 0,
        );
        if (withMeta.length === 0) return; // Not every example exercises this.

        const { document } = loadDocument(raw);
        for (const source of withMeta) {
          const loaded = document.elements.find((element) => element.id === source.id);
          expect(loaded?.meta, `meta was not preserved for ${source.id}`).toEqual(source.meta);
        }
      });
    });
  }
});

/** `updatedAt` is rewritten on every save, so it cannot participate in equality. */
function stripTimestamps(json: string): unknown {
  const parsed = JSON.parse(json) as { meta: { updatedAt?: string } };
  delete parsed.meta.updatedAt;
  return parsed;
}
