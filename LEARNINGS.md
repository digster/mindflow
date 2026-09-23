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
   offset is stable whichever font actually resolves, which is what lets
   `docs/07-rendering.md` specify baseline placement without font metrics.
4. **The editor corrects itself onto that offset** — see the next entry. Sharing
   a font stack is not enough, because the two engines *place* a baseline by
   different rules.

Positioning the editor by its **centre** (with `transform-origin` at the centre)
rather than its corner means scale and rotate leave it fixed, so no trigonometry
is needed and nothing drifts as the angle changes.

---

## A `<textarea>` does not put its baseline where the canvas does

**Symptom:** while typing, the text sits noticeably low in its box and looks
clipped by the editor outline; the instant you finish, it jumps back up and looks
right. Worse at larger font sizes, and worst on a tight, top-aligned `text`
element where the box hugs the glyphs.

**Cause:** the two engines place a baseline by different rules, and sharing a font
stack does nothing about it.

| | First baseline, from the top of the line box |
|---|---|
| Canvas (and `docs/07-rendering.md`) | `fontSize × 0.8` |
| CSS | `half-leading + ascent`, i.e. `(lineHeightPx − (ascent + descent)) / 2 + ascent` |

For the default 20px sans that is 16px against 20px — **4px, a fifth of the em**.
The CSS value is font-specific, so it cannot be predicted from the document alone.

**Fix:** `ui/textEditor.ts` measures the CSS baseline for the typography in use
(a zero-height `inline-block` at `vertical-align: baseline` sits exactly on it —
there is no API for this) and folds the difference into the same `padding-top`
that already emulates vertical alignment. Cached per typography, because it forces
layout and runs on every keystroke.

**The part worth remembering:** padding cannot be negative, and the correction is
normally *upward*. Where there is padding to give back — a sticky, a label — it is
absorbed and the editor's outline stays exactly on the element. Where there is
none — top-aligned text with zero padding — the remainder has to become a
`translateY` on the editor itself, appended **after** `scale()` so it is read in
scene units and rotates with the element.

Do not "simplify" this by deriving the offset from canvas `fontBoundingBoxAscent`
/ `Descent`. It agrees on Chrome today, but the number has to match what the
browser's own line-box algorithm actually did, and measuring is the only way to
be sure of that.

---

## The text editor focuses a frame late, and tests must wait for it

`TextEditor.open` calls `focus()` inside a `requestAnimationFrame`, so the browser
does not scroll the page to reach a textarea that has not been positioned yet.
The cost is that focus lands one frame after the click.

A test that clicks and immediately types loses the leading keystrokes — and they
do not vanish quietly, because the canvas still has focus and **letters are tool
shortcuts** there. `page.keyboard.type('Baseline')` produced the text `eline`
*and* silently switched tools partway through.

Always `await expect(page.locator('.mf-text-editor')).toBeFocused()` before
typing. No human types inside 16ms, so this is a test-harness concern only.

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

This also makes an unfilled rectangle a **bad fixture for any test about
click-through**: it is click-through already, so the test passes without proving
anything. Use a sticky, or set a fill.

---

## Click-through needs a deliberate way back, or it is a one-way door

**Symptom:** an element, once locked, could never be unlocked. Nothing on screen
could reach it again.

**Cause:** three separate correct-looking decisions composed into a trap.
`elementAt` and `elementsInBox` skip locked elements so a locked background
behaves like scenery; `selectAll` skips them for the same reason; and `toggleLock`
clears the selection on locking, because what it just locked is now scenery. Each
is defensible. Together they left no path to the Unlock button, which only ever
appears for a selection.

**Fix:** right-click falls back to a locked hit when no unlocked element is under
the pointer. Ordinary clicks are untouched, so the scenery behaviour survives
intact, and the fallback only fires where nothing else wants the event.

**The general lesson:** any rule of the form "X is invisible to the pointer" needs
a named, tested escape hatch, and the escape hatch has to be reachable *without*
the thing it unlocks. Ask "how does the user undo this?" of every state that
removes an affordance — the answer is not allowed to be "they can't".

Making a locked element selectable also means every mutating path has to exclude
it, since the selection is no longer guaranteed editable: gestures, `deleteSelection`,
`nudge`, and the style panel all filter on `locked` now. `canTransform` in
`render/overlay.ts` is the shared predicate.

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

---

## `Cmd`/`Ctrl` + `N` never reaches the page in an ordinary browser tab

**Symptom:** the "New board" shortcut appears to do nothing — or worse, opens a
new browser window — even though `installKeyboardShortcuts` clearly handles it
and calls `preventDefault()`.

**Cause:** `Cmd`/`Ctrl` + `N` is reserved by Chrome, Safari and Firefox for "new
window". Reserved shortcuts are handled by the browser chrome before the keydown
is dispatched to the document, so the page's handler never runs and there is
nothing to prevent. This is not something a web page can opt out of. The same is
true of `Cmd+T` and `Cmd+W`; MindFlow already avoids those deliberately.

It *does* fire in installed/standalone windows, where the browser has no tab UI
to serve, which is why the handler is still worth keeping.

**Consequence:** any file action bound to a reserved chord needs a visible
control as well, or the feature is unreachable. `New board` lives in the top bar
for exactly this reason, and its tooltip deliberately omits the shortcut hint
that every other file button shows. Before binding a new `Cmd`-chord, check it
against the browser's reserved list rather than assuming `preventDefault` wins.

---

## `Store.execute` detects no-op commands by reference, not by value

**Symptom:** a board goes dirty, and gains an undo step, after an interaction
that changed nothing — double-clicking a shape and closing the editor without
typing was enough. Users then get "Discard unsaved changes?" for changes they
never made.

**Cause:** `execute` bails out with `if (next === this.state.document) return
false`, which only fires when `applyCommand` returns the very same object. Any
command built from a rebuilt element — `{ ...element, text }` — produces a
structurally identical element with a *new identity*, so the check passes it
through as a real change.

**Consequence:** the "did anything actually change?" decision cannot be pushed
down into `execute`; a deep comparison there would cost more than it saves on the
hot path. It belongs to the caller, which knows whether the user did anything.
`TextEditor` tracks a `touched` flag set from `onInput`, and commits nothing when
it is false. Any other UI that writes an element back wholesale on close needs
the same guard — comparing values at commit time does **not** work, because the
transient live-update has already written them into the document.

## `Cmd+C` matched before `Cmd+Alt+C`, because it never checked `altKey`

`keyboard.ts` dispatches through a flat if-chain on `primary && key === 'c'`.
That branch tested the platform modifier and the key, and nothing else — so
`Cmd+Alt+C` matched it and copied the *elements* instead of their style, before
the style-clipboard branch was ever reached.

The fix is two-sided and both halves are needed: put the more specific chord
first, **and** make the general one explicitly reject the modifier
(`primary && !event.altKey && key === 'c'`). Ordering alone is fragile — the next
person to add a branch will not know the order is load-bearing.

Generalises: in a flat if-chain matcher, a branch that ignores a modifier claims
every chord containing it.

## A menu opened on `contextmenu` inherits a live pointer capture

`onPointerDown` calls `setPointerCapture` *before* it bails out on
`event.button === 2`. `contextmenu` then fires between down and up, so a menu
opened there is competing with a capture the canvas still holds — and because the
menu swallows the `pointerup`, the capture is never released. The symptom is
delayed and looks unrelated: the *next* left-drag on the canvas silently does
nothing.

The controller now remembers the captured pointer id (a `contextmenu` event is a
`MouseEvent` and carries none of its own) and releases it before opening the
menu. There is an e2e test that right-clicks, dismisses, then drags — it fails
without the release.

## Frame membership has to be assigned on *creation*, not only on move

Containment is recomputed when a drag ends, which covers everything that moves.
It does not cover an element drawn straight inside a frame — creation is a
`createBox` gesture, not a move — so a shape drawn into a frame was never clipped
by it. `finishCreate` needs its own call.

The general shape: any rule phrased as "recompute when X moves" needs a second
look at every path that introduces an element already in position.

## A version bump with no migration entry warns on every existing file

`needsMigration` returns true for *any* version inequality, not just an older
major. So bumping `CURRENT_SCHEMA_VERSION` while leaving `MIGRATIONS` empty makes
every previously saved board — and every shipped example — load with "No
migration is available from schema X to Y". It is only a `warning`, so the
contract test still passed, but users read it as data loss.

Additive versions need an **identity migration**. `docs/09-extending.md` said to
skip it, which was wrong; the contract test now requires one per published
version.

## Deriving `SCHEMA_URL` beats remembering to update it

The `$schema` URL stamped into every saved board was a hand-written literal
sitting three files away from the version constant, with no test relating them.
Nothing would have caught a bump that missed it, and the damage — every file
written by that build pointing at the wrong schema document — is permanent and
silent.

It is now a template literal over `CURRENT_SCHEMA_VERSION`, and the contract test
asserts the file it names is actually published. Cheaper than a checklist item.

## Two renderers agree only if they consume the same generated geometry

`style.roughness` displaces an outline randomly. The canvas renderer and the SVG
exporter are independent implementations (see above), so "both apply the same
jitter algorithm" would have meant two chances to diverge on sampling, ordering,
or how many random values each edge draws.

Instead the jitter is a pure function returning **points**, and both renderers
call it. Divergence stops being something to keep an eye on and becomes
structurally impossible. The same reasoning applies to any computed geometry the
exporter has to reproduce.

The corollary, for the format: the seed must be derivable from what is in the
file. Seeding from the element `id` means no new field, and it survives a round
trip for free.

## A `window` clipboard listener silently breaks every input on the page

Pasting an image can only be caught as a native `paste` event, and a canvas has
nothing focusable to attach the listener to — so it goes on `window`. But
clipboard events **bubble**, so that listener also sees every paste aimed at an
`<input>` in the chrome, and its unconditional `event.preventDefault()` cancels
the browser's own text insertion.

The failure mode is nasty because it is asymmetric and looks like anything but a
clipboard bug: the field accepts typing perfectly, and pasting does *nothing at
all* — no error, no console warning. It shipped affecting all five text fields in
the app (board name, find bar, command palette, Settings client ID, custom
colour) and was only noticed in one of them.

`installKeyboardShortcuts` had already solved the identical problem for
keystrokes with its `isTypingTarget` guard; the clipboard listener was written
later, in a different file, and never got it. The guard is now exported and
shared. **Any listener installed on `window` for an event that bubbles needs to
ask whether the user is typing** — `paste`, `copy`, `cut`, `keydown`, `drop`.

## …and the same listener bound too *narrowly* loses the whole board

The mirror image, found while fixing the above, and the more expensive of the
two. `dragover`/`drop` were bound to the **canvas**, which sounds conservative
and is in fact the dangerous choice: a file dropped on any other part of the page
reaches no handler, so the browser's default runs — and the default is to
*navigate to the dropped file*, discarding the app and every unsaved change. A
drop that missed the board by a few pixels looked exactly like a crash.

The rule for HTML5 file drops is that suppression and handling have different
scopes. **Suppress the default across the whole window; handle wherever makes
sense.** Binding only where you intend to handle leaves the rest of the page
live.

Two details that are easy to miss:

- Without a `preventDefault` on **`dragover`**, no `drop` event fires at all and
  the navigation happens regardless. Guarding `drop` alone does nothing.
- During `dragover` the `files` list is empty for security reasons. Test for a
  file drag with `dataTransfer.types.includes('Files')`, which is populated in
  both phases — and use it to leave text drags alone, or dragging text into a
  field breaks.

## "Rewind the transient edits" has to remember what it is rewinding *to*

Found while adding tables, and pre-existing since text editing was written:
**undo after a text edit did nothing.** Typing "hello" into a sticky, pressing
Escape and hitting `Cmd+Z` left "hello" on the note and quietly ate an undo step.

The shape of the bug is worth remembering because the code reads as correct:

```ts
// TextEditor.commit — the broken version
const element = this.store.document.elements.find((c) => c.id === id);
const next = this.withText(element, text);
store.execute(updateElements(doc, [id], () => element, 'Edit text'), true); // "rewind"
store.execute(replaceElements(doc, [next], 'Edit text'));                   // "the real edit"
```

`onInput` applies every keystroke to the live document as a **transient**
command, so that a typing session is one undo step rather than forty. By the time
`commit` runs, the document already holds the typed element — so `element` *is*
the typed state, not the pre-edit state. Two things followed:

1. The rewind was a literal no-op. `updateElements` skips a patch when the
   updater returns the same object it was given (`next !== el` is the guard), and
   `() => element` returns exactly that object.
2. The "real" command's `before` and `after` therefore carried **identical
   content** and differed only by object identity. `isNoopCommand` compares by
   reference, so it was pushed onto the undo stack — and undoing it restored the
   text to itself.

Nothing caught it. The board went dirty, the element changed, the undo button
enabled, and the stack had an entry. Only asserting on the *document after an
undo* shows it, which no test did.

The fix is to capture the element when the editor **opens** and rewind to that,
with `replaceElements` (which reads `before` from the live document) rather than
`updateElements`.

The general rule: **a rewind is defined by a value captured before the thing it
undoes, never by re-reading the state afterwards.** If a "restore the previous
state" step reads its target out of live state, ask what has already been written
to that state — and if the answer is "the edits I am about to rewind", the step
does nothing.

## Undo tests must assert on the document, not on the stack

The corollary. `canUndo()`, an enabled button, a non-empty history and a dirty
flag were all true and all meaningless above. A no-op command is still a command.
Assert what the document contains after `undo()`.

## A live colour drag is one gesture, so its *last* frame must coalesce too

A native `<input type="color">` fires `input` on every frame of a drag. Each call
into `Actions.restyle` pushed its own history entry, so picking a colour by
dragging left dozens of undo steps and `Cmd`+`Z` appeared to do nothing. That bug
shipped with the original swatch row and nothing caught it, because every proxy
looked right: the element changed, the board went dirty, the undo button enabled.

The obvious fix is half a fix. Threading `coalesce` through the preview path
merges the frames — but if the *final* value then goes through a separate
non-coalescing commit, the gesture costs **two** undos, and the first one rewinds
only the last pixel of movement. That is arguably worse than the original bug,
because it looks like it works.

A drag is one gesture from first frame to last. `input` and `change` both go
through the coalescing path; only a discrete choice — a swatch click, a typed hex
value — earns its own step. This is the model `input/controller.ts` already used
for canvas drags; the colour picker just had to adopt it.

The test that catches it asserts the user-visible property, not the mechanism:
*after one undo, the stroke is what it was before the drag started.* An assertion
about the size of the undo stack would have passed the broken version.

## Storing shorthand hex makes equal colours compare unequal

`#fff` is a valid CSS colour and the format accepts it. Writing it into a
document is still wrong: the style panel decides which swatch is active by
comparing strings, so a shape whose fill is `#fff` matches no swatch even though
`#ffffff` is right there in the palette, and two boards that are the same colour
diff as different. `normalizeColor` expands shorthand and lower-cases before
anything is stored — the "reading is lenient, writing is strict" rule applied to
one more field.

## `localStorage` can *throw* on access, not merely return null

A browser set to block site data raises on `localStorage.getItem`, and in Node
the identifier is not defined at all. Both are caught by the same `try/catch`,
which is why every access in `ui/colorPicker.ts` has one. Worth stating because
the failure mode is disproportionate: without the guard, a browser that declines
to remember a shade of blue takes the whole application down at startup.

## A whitelist that *drops* what it does not recognise is worse than none

`scripts/build-icons.mjs` extracts Lucide icons through an element and attribute
whitelist, which is the entire justification for `icon()` using `innerHTML`. The
first version skipped anything its regex did not match instead of throwing, and
that turned a safety check into a data-loss bug: the attribute-name pattern was
`[a-z-]+`, which cannot match `x1`, `y1`, `x2` or `y2`, so every `<line>` in
every icon lost its coordinates. The `frame` icon shipped as
`<line /><line /><line /><line />` — four elements drawing nothing — and looked
like a rendering problem rather than a generator one.

Nothing caught it because everything downstream was true: the file generated, the
build succeeded, the type checked, the icon existed, the SVG was in the DOM.

Two rules came out of it:

1. **Parse exhaustively, then assert nothing is left over.** After matching the
   attributes, the script now checks that the remaining text is whitespace and
   throws if it is not. That single check is what surfaced the bug.
2. **A rejection pattern must be wide enough to MATCH what it rejects.** The tag
   pattern was `[a-z-]+`, so `<foreignObject />` did not fail the "unexpected
   element" check — it failed a later backstop, by luck. A pattern that misses
   the dangerous input cannot refuse it.

The test that found this asserts on the extractor's *refusals*, not its output.

## Lucide names alignment icons after the rule's axis, not the movement

`align-start-vertical` is align-**left**: "vertical" describes the orientation of
the rule the objects land against, not the direction they travel. Six of the
eight alignment icons are named this way and picking them by name gets half of
them wrong. `test/unit/icons.test.ts` asserts against the geometry instead — that
`alignLeft` contains a rule at `x=2`, `alignBottom` one at `y=22`, and so on — so
a future icon swap cannot silently transpose them.

## A sampled arc misses the tangent points unless you make it land on them

**Symptom:** a cylinder's silhouette was `0.1` scene units short of its own
bounding box, so the top of the shape did not quite touch the top of its
selection frame.

**Cause:** arcs are sampled to polylines so the canvas and the SVG exporter
consume identical geometry. The sample count came from a spacing rule, which
meant the angular step rarely divided the arc evenly at the points where the
curve is tangent to the box — the very points that define the extent.

**Fix:** round the segment count up to a multiple of four. That puts a sample on
the arc's midpoint and, for a full ellipse, on all four quadrant points.

The general rule: **when sampling a curve whose bounding box matters, force
samples onto the extremes.** Spacing alone describes smoothness, not extent, and
here the extent is what culling, marquee selection and snapping all read.

## `roughOutline` is one closed polygon, so a multi-face shape cannot have one

The hand-drawn renderer displaces a single closed polygon, and `export.ts`
short-circuits a rough element to a single `<polygon>`. Both are fine for a
rectangle or a hexagon and impossible for a cube: its three faces share edges
that a single silhouette does not contain, so roughening would erase exactly the
lines that make it read as a solid.

The solids therefore omit `roughOutline` entirely, and get the correct UI for
free — `stylePanel.ts` gates the sketch control on `Boolean(definition.roughOutline)`.
Anything drawn from more than one contour should do the same rather than trying
to make one polygon stand in for several.

## Three renderers read a label's box, not two

`drawLabel` on the canvas, the DOM `<textarea>` overlay, and `labelToSvg` in the
exporter each place the same text independently. A solid wants its label on its
front face rather than in the centre of its bounding box, and doing that with a
`ctx.translate` inside `draw` moves only the first of the three — which shows up
as text jumping the moment editing starts, the failure mode this project has
already paid for once.

`labelBox` on the registry definition, read through `labelBoxOf`, is why all
three agree. Any future per-type text placement belongs there for the same
reason.

## Blur is a platform convention, not a way to end an edit

The text editor used to close only because pressing the canvas moved focus out
of its `<textarea>`. That is a mouse convention. On iPadOS, over a
`touch-action: none` canvas that has taken a pointer capture, a tap does not
reliably move focus at all — so the editor stayed open, focused and blinking
after the user had moved on, and the store's `editingId` (cleared by the same
press) no longer agreed with it, which let the *next* tap start a gesture
underneath a live editor.

An overlay that must close on an outside press has to close itself: an explicit
commit from the canvas handler, plus a window-level `pointerdown` listener for
everything else. `Popover` already did exactly this and was the model.

Two traps in that listener:

- **Register it a task later.** The press that opens the editor is still
  bubbling towards `window`, so a listener added synchronously dismisses the
  editor it just opened. A microtask is not enough — the dispatcher drains the
  microtask queue between listeners, so the handler still runs for the same
  event.
- **Register it on the bubble phase**, so a press on the canvas is handled once,
  by the controller, which also has to swallow it.

## Focusing inside the gesture costs you the focus, unless you prevent the default

iOS Safari raises the soft keyboard only for a `focus()` called inside a trusted
user gesture, so the editor's `focus()` had to move out of its
`requestAnimationFrame` and into the `pointerdown` handler. That immediately
broke three desktop tests: the compatibility `mousedown` the browser sends after
`pointerdown` moves focus to the document, blurring the textarea — which fired
blur-to-commit and closed the editor before a key could be pressed.

`event.preventDefault()` on that one `pointerdown` suppresses the compatibility
events and keeps the focus. Note it is done **only** where the press takes focus.
Doing it for every canvas press would stop the board-name field committing when
you click away from it, which is the same class of bug in the other direction.

## Every input constant in this app was sized for a mouse

Not one of them was wrong; all of them assumed a pointing device whose hot spot
is a single pixel and whose tremor is measured in ones. Under a finger:

- the 3px drag threshold is below the wander of a tap the user means to be
  stationary, so taps became drags — and because a gesture recomputes from its
  origin rather than from the threshold, the element jumped the whole distance;
- 8px of click tolerance makes a thin shape feel like it is dodging the tap;
- a 9.5px handle radius is hard to hit, and handles are tested *before*
  elements, so widening it too far turns "move this" into "resize this".

The fix is per-gesture, not per-device: the controller records
`event.pointerType` at pointerdown and every threshold reads from that. A media
query would have been wrong — a tablet driven with a stylus or a trackpad wants
the precise numbers, and the device having a touchscreen says nothing about what
is touching it right now.

## `pointercancel` is a real code path once there is a finger involved

It used to abandon the gesture and leave its transient edits in place. Nothing
had reached the undo stack, so the element sat where the interrupted drag left
it with no way to undo, and an interrupted *creation* left a shape that could not
be removed by undo at all. With a mouse this needed the device to be unplugged
mid-drag; with a finger the system claims the pointer for palm rejection, a
second touch, or a system gesture, routinely.

Cancelling now rewinds — transforms back to the elements captured at pointerdown,
creations deleted — and releases the pointer capture, which the handler also used
to leak. That leak's symptom was the delayed, unrelated-looking one already in
this file: the *next* drag silently does nothing.

## Chromium's touch emulation is not a touch device

The first version of the touch suite passed against the code it was written to
fix. Emulated touch still sends the compatibility mouse events, so the textarea
blurred and the editor closed by the old, accidental path — the tests asserted
the right end state and proved nothing.

What cannot be emulated is the *absence* of the focus change. The tests now
install a capture-phase `mousedown` listener that prevents the default action,
which reproduces the iPadOS condition exactly, and three of them fail without the
fix (checked by reverting it, not by reasoning about it).

The general lesson: when a bug is "the platform does not do X for us", the test
has to stop the test platform doing X. Otherwise it is a test of the harness.

## Removing an element type fails silently unless something converts it

Retiring `sphere`, `prism`, `torus` and `capsule` in schema 1.5.0 had three traps,
none of which the existing tests caught on their own:

- **An unknown type is preserved, not drawn.** That rule exists for types from a
  *newer* build, and it is right for them. Applied to a retired type it means an
  old board opens with the shape simply missing from the canvas — no error, and
  it is still in the file. Only a migration keyed on the declared version turns
  it into something drawable.
- **The contract test only looked one way.** It failed when a registered type
  had no docs section, and said nothing when docs described a type that no longer
  existed. It now checks the capability matrix in both directions.
- **A stored value the old type ignored can become visible.** Solids never drew
  `style.roughness`; every shape they convert to does. Carrying the value across
  verbatim would have made converted shapes turn sketchy on upgrade, so the
  migration zeroes it.
