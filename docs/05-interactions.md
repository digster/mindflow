# 5. Interactions

Tools, gestures, keyboard shortcuts, and the behaviour of selection, snapping and
undo.

Reference implementation: [`src/input/controller.ts`](../src/input/controller.ts),
[`src/input/keyboard.ts`](../src/input/keyboard.ts).

## Tools

| Tool | Key | Behaviour |
|---|---|---|
| Select | `V` | Click to select, drag to move, marquee on empty canvas. |
| Pan | `H` | Drag to pan. |
| Rectangle | `R` | Drag to size, or click for a default 100 × 80. |
| Ellipse | `O` | Drag to size, or click for a default 100 × 100. |
| Diamond | `D` | Drag to size, or click for a default 120 × 80. Shares its toolbar slot with the shape flyout. |
| Shapes | — | A flyout on the diamond slot, holding every closed shape: rectangle, ellipse, diamond, triangle, pentagon, hexagon, star, parallelogram, and the solids (cube, cylinder, cone, pyramid). All behave as above — drag to size, or click for the type's default. |
| Line | `L` | Drag from start to end. |
| Arrow | `A` | Drag from start to end; binds to shapes at either end. |
| Draw | `P` | Drag to draw freehand. |
| Text | `T` | Click to place and start typing. |
| Sticky note | `N` | Drag to size, or click for a default 160 × 160. |
| Table | `B` | Drag to size, or click for a default 3 × 3 at 360 × 120. |
| Frame | `F` | Drag to size, or click for a default 400 × 300. |
| Image | — | Opens a file picker, then places the image. |
| Eraser | `E` | Click or drag over elements to delete them. |

After creating an element, the tool returns to **Select** and the new element is
selected. This matches Figma and Freeform: the common case is create-then-adjust,
not create-many-in-a-row.

### The shape flyout

Twelve closed shapes cannot each have a toolbar button without turning the strip
into a wall of icons, so one slot shows the shape last chosen from the flyout and
a small opener beside it lists them all. The slot remembers its choice between
sessions, and every shape is also reachable by name from the command palette
(`Cmd`/`Ctrl` + `K`).

Only the shapes that predate the flyout carry a single-letter shortcut. Giving
nine more types a letter each would exhaust the keyboard for a gain the palette
already provides.

## The gesture lifecycle

Every pointer gesture follows the same three steps:

```
pointerdown → decide which gesture starts, capture the "before" state
pointermove → recompute from the ORIGINAL state, never incrementally
pointerup   → commit one final, non-transient command
```

**Each move recomputes from the state captured at pointerdown**, rather than
applying a delta to the previous frame. Incremental application accumulates
floating-point error across a long drag and — worse — makes a dropped or coalesced
event corrupt the result permanently. Recomputing from the origin is both simpler
and exactly correct.

Moves apply their changes as *transient* commands, which do not touch the undo
stack. On release, the gesture is replayed as one real command, so an entire drag
is a single undo step.

`pointerup` also carries its own position, which is frequently a few pixels beyond
the last `pointermove` the browser delivered. That position is applied before
committing — otherwise a shape ends up slightly smaller than where the user
actually let go.

### Drag threshold

A press becomes a drag only after the pointer travels **3 screen pixels** — or
**8** for a touch pointer. Below that it is a click. Without this, a one-pixel
tremor while clicking would nudge the element; 3px is a mouse-tremor allowance
and far below what a finger wanders during a tap the user means to be
stationary.

### If a gesture is cancelled

`pointercancel` — the system reclaiming the pointer, which is rare with a mouse
and routine with a finger — abandons the gesture and **rewinds** whatever it had
applied: a transform returns to the state captured at pointerdown, and a
creation removes the shape being drawn. Nothing had reached the undo stack, so
leaving the change in place would leave a board that undo cannot restore.

## Select tool priority

On `pointerdown`, in this order:

1. **A selection handle** (resize or rotate) — always wins, even over elements
   sitting on top of it.
2. **An element** — select it and prepare to move.
3. **Empty canvas** — start a marquee.

Holding `Shift` toggles the clicked element in or out of the selection instead of
replacing it.

## Selection

- Clicking an element selects it, replacing the current selection.
- `Shift`-click adds or removes.
- Dragging on empty canvas draws a marquee. Default mode is **contain**: an
  element must lie entirely inside the box. That is what makes dragging across a
  dense board feel precise.
- **Selection always expands to whole groups.** Selecting any member of a group
  selects its siblings — which is what makes grouping behave like a single object
  even though no group object exists.
- Locked and hidden elements are never selected by clicking or marquee.

Undoing a creation removes the element while it is still selected, so stale IDs
are pruned from the selection after every undo and redo.

### Locking

A locked element is scenery: clicks pass straight through it to whatever is
behind, and a marquee ignores it. That is the point of the lock, and it is also
a trap, because an element nothing can select is an element nothing can unlock.

**Right-clicking is the way back.** Right-click resolves to the topmost unlocked
element as usual, and only if there is none does it fall back to a locked one —
so the scenery behaviour is unaffected, while a locked element is always exactly
one right-click away.

A locked element that has been selected this way:

- draws a **dashed** selection frame with no resize or rotate handles;
- cannot be moved, nudged, resized, rotated, restyled or deleted;
- shows a style panel collapsed to a single **Unlock** button.

Unlocking is the one edit a locked element accepts.

### Align and distribute

The style panel gains an **Align** row whenever the selection covers two or more
*units*, and enables the two distribute buttons at three or more.

A **unit** is a group, or an ungrouped element. Three rules follow from that, and
they are what make the result predictable:

- **A group moves as one box.** Selecting any member expands the selection to the
  whole group, so aligning members individually would stack them on top of one
  another. The group's combined bounding box is aligned, and every member is
  shifted by the same delta, preserving the internal layout.
- **Locked elements are excluded**, and do not contribute to the bounds. They can
  be in the selection — right-clicking one is how it is reached — so, as with
  delete and nudge, they are filtered rather than assumed editable.
- **Alignment uses the rotated world box.** `x`, `y`, `width` and `height` describe
  the *unrotated* box (see [04-coordinates.md](04-coordinates.md)), so a rotated
  element's visible left edge is not `x`. Each unit's axis-aligned world bounds
  are computed first, then the difference is applied as a translation.

Distribution equalises the **gaps between boxes**, not the spacing of centres, and
holds the two extreme units in place:

```
gap = (span − Σ box widths) / (unit count − 1)
```

where `span` runs from the leading edge of the first unit to the trailing edge of
the last. Equal centre spacing looks wrong as soon as one element is wider than
its neighbours; equal gaps is what reads as evenly distributed. A negative `gap`
(overlapping elements) is left as-is — the spacing is still even.

Each operation is a single undo step, and bound connectors re-route afterwards.

## The style panel

The panel appears whenever something is selected — top right, or along the
bottom on a narrow screen — and shows only the controls the selection can use.
It is as tall as its controls and no taller, scrolling only when they outgrow the
board.

Its header names the selection (the type for one element, a count for several)
and carries a toggle that **collapses the panel to a single button**, handing the
board back to a small screen. The same toggle reopens it, as do
`Cmd`/`Ctrl` + `\` and "Show / hide style panel" in the command palette.

| | Behaviour |
|---|---|
| **Remembered** | Per browser, across selection changes and reloads — not per board, since it is a preference about the screen rather than the content. |
| **Nothing selected** | The panel is hidden, and the shortcut and command do nothing: flipping a preference with nothing on screen would only surprise the user the next time they selected something. |
| **Collapsed** | No controls are built at all. The panel is rebuilt on every document change, drag frames included, so it costs nothing while closed. |
| **Touch** | On a coarse pointer the toggle grows to 40 px. |

## Colour

Every colour in the format is settable from the interface. Which controls appear
follows from the selection's capabilities, exactly like the rest of the style
panel.

| Row | Writes | Shown when |
|---|---|---|
| **Stroke** | `style.stroke` | always |
| **Fill** | `style.fill`, and `style.fillStyle` | the selection contains something fillable |
| **Text colour** | `color`, or `label.color` | the selection can carry text |
| **Header fill** | `headerFill` | a single table with `headerRow` on |
| **Board background** | `canvas.background` | always — it is in the top bar, not the panel |

Two of these need explaining.

**Text colour writes to one of two places.** A type that owns its text directly
(`text`, `sticky`, `table`) stores `color` on the element; every other shape
stores it on `label`. One control covers both, and an element in a mixed
selection that has no label yet is skipped rather than the whole edit being
refused.

**Board background lives in the top bar**, beside the grid toggle, rather than in
the style panel. The panel is hidden whenever nothing is selected, which is
precisely when you reach for the background.

### The palette

Each row offers a small curated palette. The values are in `PALETTE`
(`src/model/defaults.ts`) and share their hues deliberately: text and stroke draw
from the same six chromatic values, and every fill is a light tint of one of
them, so a board looks composed without the user having to compose it.

A type may override a palette by declaring one on its registry definition. A
sticky note does, offering the warm paper tones it is actually created with
rather than the generic pastel washes — and it does so without any code outside
`render/shapes/` learning that sticky notes exist.

**These are offered colours, not permitted ones.** The format accepts any CSS
colour for any element, and nothing in this section constrains a document.

### The picker

The trailing swatch in each row — a rainbow ring around the colour currently in
effect — opens a popover with:

- the same palette, at a comfortable size;
- **Recent**, the last eight colours used, most-recent first, de-duplicated
  across notations so `#FFF` and `#ffffff` do not both occupy a slot. Stored in
  `localStorage` under `mindflow.recentColors`; a browser that refuses storage
  simply gets no strip;
- a **hex field**, accepting `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` with or
  without the leading `#`, in either case. Anything else is rejected visibly and
  the typed text is left alone to be corrected;
- the **system picker**, for anything else.

Values are canonicalised to lower-case six- or eight-digit hex before being
written, matching what the format says MindFlow emits.

**One drag is one undo step.** A native colour input fires an event on every
frame of a drag, so the whole interaction — including its final value — is
applied as a single coalescing gesture, the same way a canvas drag is. Clicking a
swatch or committing a hex value is a discrete choice and gets its own step.

A dark board background is offered and leaves the default near-black stroke
almost invisible. That is left as the author's call: silently recolouring
elements because the paper changed would be a far worse surprise than a board
that needs a lighter pen.

## Frames

A **frame** is a named region that clips and moves its contents. Draw one with the
frame tool (`F`), and rename it in the style panel.

- **Membership is decided on drop.** When an element is released, it joins the
  topmost frame whose box contains the element's **centre**, and leaves whatever
  frame it was in. Centre containment rather than overlap means an element
  straddling a border has exactly one unambiguous answer, and it matches the feel
  of dragging — the pointer's end of the thing is what decides.
- **Moving a frame moves its contents** by the same delta. Its members are *not*
  added to the selection, though: selecting a frame should offer to reposition its
  contents, not to restyle them.
- **Resizing a frame does not resize its contents.** It re-clips them.
- **Deleting a frame deletes its contents**, in one undo step. A frame is
  presented as a container, so leaving its contents floating where it used to be
  would be the surprising outcome.
- **The interior is click-through**, exactly like an unfilled rectangle, so
  contents stay selectable. The frame is grabbed by its **border**.
- **Frames are not rotatable**, and do not nest.

The frame's name renders above its top-left corner, outside the box. It is
deliberately not clickable — it sits outside the element's own bounding box, and
extending the hit region there would put hit-testing at odds with the bounds every
other part of the app uses for culling and selection.

## Modifiers during a drag

| Modifier | Effect |
|---|---|
| `Shift` while moving | Lock to the dominant axis. |
| `Shift` while resizing | Preserve aspect ratio. |
| `Shift` while rotating | Snap to 15° increments. |
| `Shift` while drawing a shape | Constrain to a square / circle. |
| `Shift` while drawing a line | Constrain to 45° increments. |
| `Alt` / `Option` while resizing | Resize about the centre. |
| `Alt` / `Option` while drawing a shape | Draw from the centre. |
| `Alt` / `Option` while moving | **Suspend snapping**, for exact placement. |

Resizing never flips: dragging a handle past its anchor clamps at a 4-unit
minimum. The format guarantees positive dimensions, and mirroring geometry
mid-drag is a surprising interaction no whiteboard offers.

## Panning and zooming

| Input | Action |
|---|---|
| `Space` + drag | Pan, from any tool. |
| Middle-button drag | Pan, from any tool. |
| Pan tool + drag | Pan. |
| Two-finger scroll / wheel | Pan. |
| Two-finger drag on a touchscreen | Pan. See [Touch](#touch). |
| Pinch on a touchscreen | Zoom about the fingers' midpoint. See [Touch](#touch). |
| `Ctrl`/`Cmd` + wheel | Zoom about the pointer. |
| Trackpad pinch | Zoom about the pointer. |

Browsers report a trackpad pinch as a wheel event with `ctrlKey` set, which is why
pinch and Ctrl-scroll are the same code path.

Zoom is **exponential** — `zoom × exp(−deltaY × 0.01)` — so each notch is a
constant *ratio*, which is what makes zooming feel linear to the hand. Clamped to
`[0.1, 30]`.

Zooming keeps the scene point under the pointer stationary:

```js
function zoomAbout(viewport, newZoom, screenAnchor) {
  const scene = screenToScene(screenAnchor, viewport);
  return { zoom: newZoom,
           x: scene.x - screenAnchor.x / newZoom,
           y: scene.y - screenAnchor.y / newZoom };
}
```

**Panning and zooming are not edits.** They never mark the board dirty and never
land on the undo stack.

## Touch

MindFlow is built for a pointer, and everything below exists so a finger is not
a second-class one. Each accommodation keys off the *pointer type of the gesture
in progress*, not off whether the device has a touchscreen — a tablet driven with
a stylus or a trackpad keeps the precise thresholds.

| Gesture | Behaviour |
|---|---|
| Tap | Select, or place the active tool's shape. |
| Drag | Move, resize, marquee — as with a mouse, past the 8px threshold. |
| Double tap | Edit text, the touch equivalent of a double click. |
| Long press | Open the context menu. |
| Two-finger drag | Pan. |
| Pinch | Zoom, about the midpoint of the two fingers. |

**Targets are larger.** Click tolerance is **16 screen pixels** for a touch
pointer rather than 8, and a selection handle's hit slop is 11 rather than 5. A
cursor's hot spot is one pixel; a fingertip covers roughly forty and hides what
is beneath it.

**Double tap is recognised directly**, from two taps within **320ms** and **24
screen pixels** that did not become drags. The browser's own `dblclick` is
synthesised from two compatibility click pairs, which a touchscreen does not
reliably produce over a canvas that takes a pointer capture — and before this it
was the only route into editing an existing element.

**A long press opens the context menu.** The press has already begun a move by
the time the browser reports it, so that gesture is abandoned — which is free,
because a press that has not crossed the drag threshold has changed nothing.

**A second finger starts a pan and zoom**, and abandons whatever the first one
had begun — rewinding it rather than committing it, since the user was reaching
to zoom, not to move something. The new viewport is:

```
ratio  = spread(fingers now) / spread(fingers at touchdown)
zoom   = clamp(zoom at touchdown x ratio, 0.1, 30)
x      = anchor.x - midpoint(now).x / zoom
y      = anchor.y - midpoint(now).y / zoom
```

where `anchor` is the scene point under the midpoint of the fingers when they
landed, resolved in the viewport of that moment. One expression covers the pan
and the zoom together, which is what keeps the board stuck to the fingers.

Like every other gesture it is recomputed from the state captured at touchdown,
so the fingers returning to where they started returns the board exactly with
them. Lifting either finger ends the gesture; the remaining one does not inherit
a drag, which would lurch the board from wherever that finger had travelled to.

**The page itself never zooms.** A pinch or a double tap anywhere else, such as
the top bar, the tool palette or a panel, does nothing. Browsers would otherwise
zoom the whole app, leaving a UI larger than the screen and no control that can
undo it. Three layers block it, because each browser listens to a different one:

| Layer | Stops | Where |
|---|---|---|
| `user-scalable=no, maximum-scale=1` in the viewport meta | Mobile Chromium and Firefox. Also the zoom iOS Safari starts by itself when a small-text field takes focus. | `src/index.template.html` |
| `touch-action: pan-x pan-y` on the page, repeated on each scrolling container | Pinch and double-tap zoom in every engine, including a touchscreen laptop, whose desktop browser ignores the viewport meta. Panels still scroll. | `src/styles/app.css` |
| Cancelling `gesturestart`, `gesturechange` and `gestureend` | iOS Safari, which ignores `user-scalable=no` for a pinch. | `src/input/pageZoom.ts` |

The canvas is `touch-action: none` and does its own pan and pinch, above, so
that is the only zoom a finger reaches. The gesture events are cancelled only on
a device that reports touch points. macOS Safari sends the same events for a
trackpad pinch, and that is left as it was.

**Ending a text edit does not depend on focus.** See
[Text editing](#text-editing).

## Snapping

Two mechanisms, applied in this order. Object snap wins when both apply —
aligning to a neighbour is almost always what someone means; the grid is a
fallback for when there is no neighbour.

### 1. Object snap

Aligns the dragged selection's edges and centres with those of nearby elements.
Three positions per axis on each box — the two edges and the centre — giving the
nine classic alignment relationships (left-to-left, left-to-centre,
centre-to-right, …) without special-casing any of them.

Threshold is **6 screen pixels**, converted to scene units by dividing by zoom.
Screen-relative on purpose: at 25% zoom a fixed scene threshold would be under two
screen pixels and unreachable; at 400% it would grab from a centimetre away.

An orange dashed guide is drawn spanning from the aligned neighbour to the moving
box, so it is visible *what* aligned to *what*.

Considers at most 200 nearby elements, which bounds cost on very large boards.

**Never snaps to a connector bound to anything being moved.** Such a connector is
re-routed from the moving shape on every frame, so it is not a fixed neighbour.
Aligning to it fed each frame's position into the next one. The shape ran ahead of
the pointer, then jumped back once the snap radius was exceeded, which looked like
a shape vibrating as it was dragged. The exclusion set is taken at pointerdown:
the moving elements plus every connector bound to one of them at either end.

### 2. Grid snap

Active only when `canvas.grid.snap` is true. Rounds the moving box's top-left to
the nearest multiple of `canvas.grid.size`.

Toggling the grid in the UI turns snapping on and off with it. A visible grid you
cannot snap to is a decoration, and separating the two is a setting nobody asks
for.

## Connector binding

While dragging an arrow endpoint, any bindable shape within **12 scene units** of
the pointer is highlighted in green. Releasing there creates a binding.

Where the endpoint lands decides the anchor mode. With `u` and `v` the drop
position normalised to the shape's box:

- **Near the centre** (`|u − 0.5|` and `|v − 0.5|` both at most 0.1) → an `auto`
  anchor, aimed through the exact centre. Dragging from the middle of a box
  almost always means "from this box", and a radial arrow stays tidy as the
  shapes move.
- **Elsewhere comfortably inside** (`u` and `v` both between 0.15 and 0.85) → a
  `focus` anchor that remembers the drop point. The tip lands where the drawn
  line crosses the outline, and keeps aiming through that point as the shapes
  move. This is what makes the start of an arrow stay where it was drawn from.
  Before 1.6.0 every drop in this zone became `auto`, so all of them collapsed to
  the same spot on the outline, facing the other shape's centre.
- **Near or beyond the outline** → a `fixed` anchor pinned to that exact spot, for
  when a specific attachment point matters.

Both zones are normalised rather than measured in scene units, so they scale with
the shape and are as easy to hit on a small sticky as on a large frame.

**Both ends on the same shape:** only `fixed` ends bind, and any other end is left
free. An `auto` or `focus` end aims through its shape toward the other end, which
means nothing when that end is inside the same shape: two focus ends would each
point out past the opposite edge, reversing the arrow. So an arrow sketched
between two spots inside a frame stays exactly as drawn, and an edge-to-edge loop
on one shape still binds at both ends.

The binding distance is generous on purpose: binding is the desired outcome far
more often than not, and an unwanted binding is undone by dragging the end away.

Deleting a shape clears any bindings pointing at it **in the same command**, so
undo restores both the shape and its connections in one step.

## Text editing

Double-clicking an element that can hold text opens an in-place editor. For `text`
and `sticky` elements this edits their `text`; for a `table` it edits **the cell
that was double-clicked**; for every other type it edits the `label`, creating one
if the element does not have it yet.

| Key | Effect |
|---|---|
| `Enter` | Newline. |
| `Cmd`/`Ctrl` + `Enter` | Finish editing. |
| `Escape` | Finish editing, **keeping** what was typed. |
| `Tab` / `Shift` + `Tab` | Next / previous cell, in a table. |
| Click or tap elsewhere | Finish editing. |

`Escape` means "stop editing", not "undo" — matching every other canvas tool. The
whole typing session collapses into one undo step.

**"Elsewhere" means anywhere outside the editor**, including the toolbar and the
style panel, and the editor commits explicitly rather than waiting to lose focus.
Whether pressing a button moves focus out of a text field is a platform
convention rather than a guarantee, and on a touch screen a tap on the canvas may
not move focus at all — which left the caret alive on an iPad long after the user
had moved on. The press that dismisses the editor does not also act on the board.

`Tab` stops at the last cell rather than wrapping round to the first. Wrapping
would silently discard the "I am done here" reading of a final `Tab`, with no
visual cue that anything had happened. Each cell commits as its own undo step, so
undo walks a tabbed pass back cell by cell.

While the editor is open, canvas shortcuts are suppressed so that typing `v` does
not switch tools.

## Tables

Beyond text editing, a table has two structural gestures.

**Dragging a divider** re-proportions a column or a row. Interior gridlines of the
**selected** table become draggable within the usual handle slop, and the cursor
turns to `col-resize` or `row-resize` over one. Dragging sets the size of the
track *left of* (or *above*) the divider and moves everything after it along, so
the table grows or shrinks rather than the neighbouring track absorbing the
change — no fighting a neighbour's minimum size, which is 16 scene units.

Dividers are offered only on a single selected, unlocked table. A divider is a
fine adjustment to something you are already working on; making every gridline on
the board draggable would make ordinary clicks near one unpredictable. The cursor
is the whole affordance — drawing chrome on every gridline would clutter the very
thing it sits on.

**Rows and columns** are added and removed from the right-click menu, which knows
which cell was clicked: *Insert row above/below*, *Insert column left/right*,
*Delete row*, *Delete column*. The style panel carries the same operations without
a cell to work from, so its versions append and remove at the far edge, alongside
the header-row toggle. The last row and the last column cannot be deleted — a
table with no cells has no way back.

Inserting and deleting adjust the element's box so that every track the user did
not touch keeps its rendered size: adding a row makes the table taller rather than
squeezing the existing rows.

## Keyboard shortcuts

`Cmd` on macOS, `Ctrl` elsewhere.

### Edit

| Shortcut | Action |
|---|---|
| `Cmd` + `Z` | Undo |
| `Cmd` + `Shift` + `Z`, `Cmd` + `Y` | Redo |
| `Cmd` + `C` / `X` / `V` | Copy / Cut / Paste |
| `Cmd` + `Alt` + `C` / `V` | Copy / paste style |
| `Cmd` + `D` | Duplicate |
| `Cmd` + `A` | Select all |
| `Delete` / `Backspace` | Delete selection |
| Arrow keys | Nudge 1 unit |
| `Shift` + arrow keys | Nudge 10 units |
| `Escape` | Deselect, close editor, return to Select |

### Arrange

| Shortcut | Action |
|---|---|
| `Cmd` + `G` | Group |
| `Cmd` + `Shift` + `G` | Ungroup |
| `Cmd` + `]` | Bring forward |
| `Cmd` + `Shift` + `]` | Bring to front |
| `Cmd` + `[` | Send backward |
| `Cmd` + `Shift` + `[` | Send to back |

### Find and run

| Shortcut | Action |
|---|---|
| `Cmd` + `K` | Command palette |
| `Cmd` + `F` | Find on board |
| Right-click | Context menu |

### View

| Shortcut | Action |
|---|---|
| `Cmd` + `+` / `-` | Zoom in / out |
| `Cmd` + `0` | Reset zoom to 100% |
| `Cmd` + `1` | Zoom to fit (selection, or the whole board) |
| `Cmd` + `\` | Show / hide the style panel |

### File

| Shortcut | Action |
|---|---|
| `Cmd` + `S` | Save |
| `Cmd` + `Shift` + `S` | Save as |
| `Cmd` + `O` | Open |
| `Cmd` + `N` | New board |
| `Cmd` + `Shift` + `E` | Export |

`Cmd`/`Ctrl` + `N` is the one shortcut that is not dependable: browsers reserve
it for "new window" and generally never deliver the keydown to the page, so the
handler cannot suppress it. It works in installed/standalone windows. Everywhere
else, the **New board** button in the top bar is the reliable path — which is why
that button exists even though every other file action is shortcut-first.

Two rules govern shortcut handling:

1. **Never steal a keystroke from a focused text field.** A user renaming a board
   must be able to type "v" without switching tools.
2. **Never override a browser shortcut the user relies on** — `Cmd+R`, `Cmd+T`,
   `Cmd+W`, `Cmd+L` all fall through untouched.

While a floating menu has keyboard focus (the context menu, the shape flyout,
recent boards, the command palette or the find bar), **its unmodified keys
belong to it**. They never reach the shortcuts above, so arrow keys, `Delete`,
tool letters and `Space` act on the menu and not on the board behind it.
`Cmd`/`Ctrl` chords still go through, and `Escape` closes the menu without also
deselecting.

## Clipboard

Copy writes to **both** the system clipboard (as JSON tagged with a private
marker) and an internal fallback. Paste prefers the system clipboard, so copying
between two MindFlow tabs works, and falls back to the internal copy when
clipboard permission is unavailable.

Pasted elements get **fresh IDs**, and:

- **Group membership is remapped**, not copied. Pasting two members of one group
  produces a *new* group containing the copies, rather than silently enrolling
  them into the original.
- **Bindings to elements outside the copied set are dropped.** The copy would
  otherwise be tethered to the original's neighbours.
- **Embedded images travel with the copy**, so pasting into a different board
  carries the pixels.

Pasting an image from the system clipboard imports it directly.

Rule 1 above applies to the clipboard as much as to the keyboard. Pasting an
image has to be caught as a **native `paste` event**, and since a canvas has
nothing focusable to bind to, that listener lives on `window` — where it also
receives pastes that bubbled up out of a focused field in the chrome (the board
name, the find bar, the command palette, the Settings client ID). Those are left
entirely to the browser. Claiming them would call `preventDefault` on the
browser's own text insertion, producing a field that can be typed into but not
pasted into.

**One press pastes once.** `Cmd`/`Ctrl` + `V` on the board can arrive twice, as
the `keydown` and then as the native `paste` event the browser fires for it.
Chrome and Firefox send both; WebKit enables Paste outside an editable field only
when a `beforepaste` listener cancels it, so Safari and an iPad with a hardware
keyboard may send the keydown alone. The native event is preferred, since only it
carries image data. The keydown waits up to 100 ms for it and pastes by itself
only if nothing arrives. A native event that turns up after that fallback has
pasted (within one second) is treated as the same press and discarded.

### The style clipboard

`Cmd`/`Ctrl` + `Alt` + `C` and `V` copy and paste **appearance** rather than
elements: the full `style` object plus `opacity`, and the typography of whichever
field the source element keeps its text in.

That last part is the reason it is not simply a `style` spread. A `text` or
`sticky` element holds its typography directly; every other shape holds it inside
`label`. The clipboard reads from whichever the source uses and writes to
whichever the target uses, so a sticky's font can be pasted onto a rectangle's
label. What an element *says* never travels — `text` is content, not appearance.

The style clipboard lives for the session only and is never written to the
document. Pasting onto many elements is one undo step, and locked elements are
skipped.

## The context menu

Right-click opens a menu of actions for the current selection, or for the board
when the click lands on empty canvas. Every entry delegates to the same action
layer the toolbar and keyboard use, so behaviour cannot drift between routes.

- Right-clicking an unselected element selects it first; right-clicking inside an
  existing multi-selection leaves that selection intact.
- Entries that do not apply are **disabled rather than hidden**, so the menu keeps
  a stable shape and can be used from muscle memory.
- On a **locked** element the menu collapses to a single **Unlock**, matching the
  style panel. This is the other half of the escape hatch described above.
- `Escape` dismisses the menu without clearing the selection.
- The arrow keys, `Home` and `End` move the highlight, and `Enter` or `Space`
  runs the highlighted entry. Unmodified keys stay in the menu, so an arrow key
  does not also nudge the selection behind it and a letter does not switch
  tools. Chords such as `Cmd+S` and `Cmd+Z` still work.
- On a **table** the menu gains row and column entries for the cell that was
  right-clicked. These are the only commands in the app that depend on *where*
  the click landed rather than on what is selected, which is why they live here
  and not in the style panel.

## The command palette

`Cmd`/`Ctrl` + `K` opens a searchable list of every command, generated from one
registry (`src/app/commands.ts`) rather than a hand-maintained copy of what the
toolbar and keyboard already do.

- Matching is a **subsequence**, so `zf` finds "Zoom to fit". A literal hit ranks
  above a scattered one, and a hit at a word boundary above one buried mid-word.
- Commands that cannot currently run are **greyed out rather than hidden**, which
  is what keeps them discoverable.
- Entries are rebuilt each time the palette opens, because whether a command
  applies depends on live state.

The palette is also the keyboard route to the **file** actions. `Cmd`/`Ctrl` + `N`
is claimed by every major browser for "new window" and never reaches the page, so
before the palette existed the toolbar button was the only way to start a blank
board.

## Find on board

`Cmd`/`Ctrl` + `F` searches the text of `text` and `sticky` elements, every cell
of a `table`, and the `label` of every other shape, case-insensitively. A query
never matches across a cell boundary — cells are joined with newlines, so each is
independently findable and no false hit spans two of them.

Taking `Cmd`+`F` from the browser is deliberate, and is the one exception to the
rule above about not overriding browser shortcuts. Canvas text is painted pixels,
not DOM, so the browser's own find can never match anything on a board — its
dialog would be strictly useless here.

- `Enter` and `Shift`+`Enter` step forward and back through matches, wrapping at
  the ends.
- Each match is selected and the viewport centred on it, at the current zoom.
- **Hidden elements are skipped** — centring on something invisible is not a
  useful answer. **Locked elements are still found**, since locked means scenery,
  not unreadable.
- `meta` is never searched. It is the namespace reserved for third-party tools,
  which MindFlow does not interpret.

## Drag and drop

- Dropping an **image file** onto the canvas imports it at the drop point.
- Dropping a **`.mindflow.json` file** opens it as a board, after confirming any
  unsaved changes.

A file dropped **anywhere on the window** is accepted, not only over the canvas.
This is a safety requirement before it is a convenience: the browser's default
action for a file dropped on a page is to *navigate to that file*, so a drop that
lands on the top bar or the style panel instead of the board would otherwise
discard the app and any unsaved work with it. Both listeners therefore sit on
`window`, and:

- An image dropped over the chrome has no meaningful scene point under the
  cursor, so it lands at the **viewport centre** — the same fallback pasting an
  image uses. A board file ignores the point entirely.
- A drop while a **modal dialog is open** is swallowed: the default is still
  suppressed, but nothing is imported. Replacing the board out from under an open
  dialog is worse than ignoring the gesture.
- A drag carrying **no files** is left untouched, so text can still be dragged
  into the board-name field. Same rule as the keyboard and clipboard handlers.

## Recent boards

The **logo** at the left of the top bar opens a menu of every board that has a
copy in this browser, newest first. *Recent boards…* in the command palette
opens the same menu. How copies are stored, capped and recovered is specified
in [06-persistence.md](06-persistence.md#autosave-and-recent-boards).

- Each row shows the board's name, element count and when it last changed.
  **Unsaved** marks a board with changes that were never saved to a file or to
  Drive.
- The board on screen is listed and tagged **Open**, but cannot be reopened or
  removed from here.
- Choosing a board asks first if the current one has unsaved changes, the same
  as New board and Open.
- The trash button removes a board's copy from this browser. It asks first only
  for a board marked unsaved. It appears on hover or focus where there is a
  mouse, and is always visible on touch.
- The arrow keys move between boards and Enter opens the focused one. With
  focus in the menu, unmodified keys stay in the menu: an arrow key does not
  also nudge the selection behind it. Chords such as `Cmd+S` still work.

## Undo

Undo is command-based rather than snapshot-based. Each command records `before`
and `after` for **only the elements it touched**, so inverting is a matter of
swapping those two fields — correct by construction for create, delete, update,
restyle and reorder alike.

- Depth: **200 steps**.
- Any new edit **clears the redo stack**. Linear history; branching confuses far
  more than it helps.
- **Coalescing:** consecutive commands with the same label arriving within 600 ms
  merge into one step. Holding an arrow key is one undo, not forty. A pause
  mid-gesture starts a new step, because the user perceives two movements.
- No-op commands are dropped, so clicking a shape and putting it back where it was
  leaves no useless undo entry.

## Accessibility

- All controls are real `<button>` elements with `aria-label` and, where they
  represent state, `aria-pressed`. The style panel's collapse toggle reports
  `aria-expanded` and points at the region it hides with `aria-controls`.
- Dialogs use the native `<dialog>` element, which supplies focus trapping, the
  top layer, and Escape-to-close.
- Notifications are announced via `role="status"` with `aria-live="polite"`.
- `prefers-reduced-motion` disables all transitions.
- `prefers-color-scheme` selects a full dark theme.

**Known limitation:** canvas content itself is not exposed to screen readers.
Drawing on an infinite canvas is an inherently visual task, and MindFlow does not
currently provide a structural alternative view of a board's contents. The save
format is fully machine-readable, which makes such a view straightforward to build
externally — but it is not built here.
