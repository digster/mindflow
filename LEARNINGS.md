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
