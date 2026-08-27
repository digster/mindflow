/**
 * Types for `build-icons.mjs`, so `test/unit/icons.test.ts` can import it under
 * `strict` without `allowJs`.
 *
 * The script itself stays plain JavaScript because it is a build tool, not part
 * of the app: it runs under bare `node` with no transpile step, exactly like
 * `build.mjs`. Only the test needs to see its shape.
 */

/** MindFlow icon name -> Lucide slug. */
export declare const MANIFEST: Record<string, string>;

/**
 * Pulls the drawable children out of one Lucide SVG.
 *
 * Throws on anything outside the element and attribute whitelist, including
 * content it could not parse — see the note in the script on why dropping the
 * unrecognised rather than throwing is the dangerous option.
 */
export declare function extract(slug: string, source: string): string;

/** Builds the full contents of `src/ui/icons.ts`. */
export declare function generate(): Promise<string>;
