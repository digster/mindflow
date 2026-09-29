/**
 * A bundled font file, as `build.mjs` inlines it: the TTF compressed with zlib
 * (deflate), then base64-encoded. `src/render/fonts.ts` decodes it.
 */
declare module '*.ttf' {
  const deflatedBase64: string;
  export default deflatedBase64;
}
