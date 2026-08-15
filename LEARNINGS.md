# Learnings

Non-obvious things about this codebase and the platform it runs on. Each entry
cost real debugging time or was a trap that was avoided deliberately — read
before changing the area it describes.

---

## `file://` blocks ES modules, which dictates the whole build

**Symptom:** a page that works perfectly over `http://` shows a blank screen with
a CORS error when opened by double-clicking.

**Cause:** browsers fetch `<script type="module">` with CORS semantics. A page
loaded from `file://` has an opaque origin, so every module fetch is blocked.

**Consequence:** "runnable without a server" and "ES modules in the shipped page"
are mutually exclusive. This is why `build.mjs` bundles to an **IIFE** and inlines
everything into one `index.html`, and why introducing a module script would break
the project's second hard requirement.

The e2e suite loads the built file over `file://` and asserts zero non-`file://`
requests, so this cannot regress silently.

---

## Inlined JavaScript can close its own `<script>` tag

**Symptom:** the page breaks in a way that makes no sense — the JS is truncated
mid-expression, with a syntax error pointing at valid code.

**Cause:** if the bundle contains the literal text `</script>` anywhere, including
inside a string, the HTML tokenizer closes the script block there.

**Fix:** `escapeForInlineScript` in `build.mjs` rewrites `</script` to `<\/script`.
That is an identical JavaScript string and inert to the HTML parser.

---

## OAuth cannot work from `file://`, ever

A page opened from disk reports its origin as `null`, and Google will not accept
`null` as an authorised JavaScript origin.

This is a constraint of OAuth, not something to engineer around. Google Drive is
therefore an HTTP(S)-only feature; the app detects the protocol and says so rather
than failing obscurely. `npm run serve` exists to provide a real origin locally.

---

## Canvas and DOM text layout must be made to agree

**Symptom:** text visibly jumps the instant you start or stop editing it.

**Cause:** editing happens in a real `<textarea>` overlaid on the canvas. Two
independent layout engines must produce identical line breaks and glyph
positions.

**What makes them agree** (all three are required):

1. **Font size in scene units; zoom as a CSS transform.** Set the textarea's
   `font-size` to the element's own `fontSize` — *not* `fontSize × zoom` — and
   scale the whole textarea with `transform`. The canvas does the same (context
   scale, font in scene units), so both lay out at the same nominal size and
   scaling happens afterwards, identically. Multiplying the font size by zoom lets
   sub-pixel rounding differ between them.
2. **Identical font stacks** on both sides — `FONT_STACKS` is shared.
3. **A fixed `0.8em` baseline offset**, not `textBaseline = 'middle'`. `middle` is
   defined against font-specific metrics and drifts between typefaces; a fixed
   offset is stable whichever font actually resolves.

Positioning the editor by its **centre** (with `transform-origin` at the centre)
rather than its corner means scale and rotate leave it fixed, so no trigonometry
is needed and nothing drifts as the angle changes.

---

## `pointerup` carries a position, and it is usually not the last `pointermove`

**Symptom:** shapes end up a few pixels smaller than where you released; a marquee
selects nothing despite being dragged across the whole board.

**Cause:** the browser does not guarantee a final `pointermove` at the release
position. Committing the gesture using only the last `pointermove` loses the last
few pixels — and for a fast marquee drag, it can lose almost the entire gesture.

**Fix:** `onPointerUp` re-runs the gesture update with the release position before
committing. Applies to shape creation, connector creation, marquee, move, resize
and rotate.

Found by an e2e test whose marquee selected zero elements.

---

## Unfilled shapes are hollow to clicks — by design

**Symptom:** "clicking the middle of my rectangle doesn't select it."

**Not a bug.** A shape with `fillStyle: 'none'` is hit only near its outline, so
you can click *through* the hollow middle to reach whatever is behind. Every
drawing tool behaves this way, and it is the single most important detail in
making selection feel right.

The default style *is* unfilled, so this is the common case. When writing tests,
either grab the outline or give the shape a fill first.

---

## Resize handles beat elements, so a fresh shape is hard to grab

A newly-created element is selected, and its resize handles sit **on** its
outline. Pressing there starts a resize, not a move — correct behaviour, since
handles must take priority over whatever is beneath them.

In tests: press `Escape` first, or grab a point on the edge that is clear of the
eight handle positions.

---

## Resizing a rotated element: the anchor must not move

**Symptom:** a rotated shape drifts sideways as you resize it.

**Cause:** the handle diagonally opposite the one being dragged is supposed to
stay fixed in world space, and naive implementations let it move.

**Fix:** solve for the origin directly. For a point at local position `a` in a box
of size `(w, h)`, its offset from the centre is `d = (a.x − w/2, a.y − h/2)` —
which depends only on the new **size**, not the unknown origin. So
`world = c + R(θ)·d`, and setting `world` to the anchor's fixed position gives:

```
x = anchorWorld.x − w/2 − (R(θ)·d).x
y = anchorWorld.y − h/2 − (R(θ)·d).y
```

Closed-form, exact, no drift across a long drag. Tested at every angle and for
every handle in `test/unit/binding.test.ts`.

---

## Undo coalescing: keep the *original* `before`

**Symptom:** undo after a drag jumps to somewhere in the middle of the gesture
instead of where it started.

**Cause:** when merging two coalesced commands, taking the newer command's
`before` discards the gesture's starting state.

**Rule:** keep the **original** `before` and adopt the **new** `after`. Getting
this backwards is the classic coalescing bug. Pinned by a test.

---

## `+y` points down, so the standard rotation matrix is already clockwise

On a canvas, `+y` is downward. The textbook rotation matrix therefore produces
**clockwise** motion on screen — which is what the format specifies, so no sign
flip is needed.

It is easy to "fix" this into being wrong. A point at `(10, 0)` rotated 90° must
land at `(0, 10)`, i.e. below the origin. Tested.

---

## Recompute gestures from the origin, never incrementally

Each `pointermove` recomputes from the state captured at `pointerdown`, rather
than applying a delta to the previous frame.

Incremental application accumulates floating-point error across a long drag and,
worse, makes a dropped or coalesced event corrupt the result *permanently* —
there is no way to recover the lost delta. Recomputing from the origin is both
simpler and exactly correct.

---

## Round coordinates on save, or every diff is noise

Without rounding, dragging a shape one pixel and back leaves
`"x": 100.00000000000001`. Two decimals is far finer than any display resolves at
sane zoom levels, and it makes save/load/save byte-stable — which the round-trip
contract test depends on.

---

## Fractional `zIndex` eventually runs out of room

Inserting between the same pair repeatedly halves the gap each time; about ten
repetitions exhausts float precision and produces ties with non-deterministic
paint order.

`needsReindex` detects gaps below `0.001` and `reindexZ` renormalises the stack.
Cheap and almost never needed, but without it a pathological editing session
eventually corrupts layer order.

---

## localStorage is far too small for autosave

A board with two pasted photos exceeds the ~5 MB localStorage quota immediately,
and the synchronous write janks the canvas on every save.

Autosave uses **IndexedDB**. It also disables itself after a failure rather than
erroring on every subsequent edit — a full quota or private browsing should
degrade quietly, not nag.

### …and IndexedDB is blocked on `file://` anyway

Browsers refuse IndexedDB to `file://` pages: the origin is opaque, so there is no
meaningful boundary to scope a database to.

So on the double-click path — the one this project specifically supports —
autosave never works. The app reports it once and carries on; explicit `Cmd+S`
saving is unaffected.

Worth knowing before "fixing" the warning: it is browser policy, not a bug. It is
also a good example of why the failure path had to degrade quietly rather than
throw — the unsupported case is a *first-class* use case here, not an edge case.

---

## Canvas has a maximum size, and exceeding it fails silently

Most browsers cap a canvas around 16,384px per side. Beyond that, `toBlob`
produces a **blank image rather than an error**, which is a miserable thing to
debug.

PNG export caps the effective scale so `bounds × scale` cannot exceed 16,000 on
either axis.

---

## SVG export is a second renderer, and cannot be otherwise

A `draw()` that issues canvas calls produces pixels, not markup. There is no way
to derive SVG from it, so `export.ts` re-expresses every shape's geometry.

That means geometry lives in two places and can drift. The mitigation is that both
are driven from the algorithms in `docs/07-rendering.md`, and shared maths
(smoothing, routing, text layout) is imported rather than re-derived — only the
output *syntax* differs.

**When adding an element type, remember the exporter.** PNG needs nothing; SVG
needs a case.

---

## `drive.file` cannot see files the user added by hand

The scope grants access only to files the app itself created. A board dropped into
the MindFlow folder through drive.google.com is invisible to MindFlow.

This is exactly what `drive.file` means and is not fixable without the Google
Picker. Documented in `docs/08-google-drive.md` rather than worked around;
widening the scope would move it into Google's restricted category and require
verification review.

---

## Drive's query syntax uses single-quoted literals

A folder or board name containing an apostrophe breaks a `q=` query, or worse
alters its meaning. `escapeQueryValue` in `src/io/drive/api.ts` handles it.

---

## `setPointerCapture` throws for synthetic events without a real pointer

When driving the app from the console or a test with hand-built `PointerEvent`s,
`setPointerCapture` can throw `NotFoundError` and abort `onPointerDown` before any
gesture is set up — so nothing happens and there is no error to see.

Playwright's `page.mouse` drives real pointers and is unaffected. Prefer it over
synthetic events for gesture tests.

---

## `noUncheckedIndexedAccess` is on, and it earns its keep

`points[0]` is `PointTuple | undefined`. It makes geometry code slightly noisier,
and it has caught several real off-by-one errors in path handling. Guard or assert;
do not disable it.
