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
| Diamond | `D` | Drag to size, or click for a default 120 × 80. |
| Line | `L` | Drag from start to end. |
| Arrow | `A` | Drag from start to end; binds to shapes at either end. |
| Draw | `P` | Drag to draw freehand. |
| Text | `T` | Click to place and start typing. |
| Sticky note | `N` | Drag to size, or click for a default 160 × 160. |
| Frame | `F` | Drag to size, or click for a default 400 × 300. |
| Image | — | Opens a file picker, then places the image. |
| Eraser | `E` | Click or drag over elements to delete them. |

After creating an element, the tool returns to **Select** and the new element is
selected. This matches Figma and Freeform: the common case is create-then-adjust,
not create-many-in-a-row.

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

A press becomes a drag only after the pointer travels **3 screen pixels**. Below
that it is a click. Without this, a one-pixel tremor while clicking would nudge
the element.

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

### 2. Grid snap

Active only when `canvas.grid.snap` is true. Rounds the moving box's top-left to
the nearest multiple of `canvas.grid.size`.

Toggling the grid in the UI turns snapping on and off with it. A visible grid you
cannot snap to is a decoration, and separating the two is a setting nobody asks
for.

## Connector binding

While dragging an arrow endpoint, any bindable shape within **12 scene units** of
the pointer is highlighted in green. Releasing there creates a binding.

Where the endpoint lands decides the anchor mode:

- **Comfortably inside** the shape (normalised `u` and `v` both between 0.15 and
  0.85) → an `auto` anchor, which tracks the other end and always attaches to the
  nearest edge. This is the default behaviour people expect.
- **Near or beyond the outline** → a `fixed` anchor pinned to that exact spot, for
  when a specific attachment point matters.

The binding distance is generous on purpose: binding is the desired outcome far
more often than not, and an unwanted binding is undone by dragging the end away.

Deleting a shape clears any bindings pointing at it **in the same command**, so
undo restores both the shape and its connections in one step.

## Text editing

Double-clicking an element that can hold text opens an in-place editor. For `text`
and `sticky` elements this edits their `text`; for every other type it edits the
`label`, creating one if the element does not have it yet.

| Key | Effect |
|---|---|
| `Enter` | Newline. |
| `Cmd`/`Ctrl` + `Enter` | Finish editing. |
| `Escape` | Finish editing, **keeping** what was typed. |
| Click elsewhere | Finish editing. |

`Escape` means "stop editing", not "undo" — matching every other canvas tool. The
whole typing session collapses into one undo step.

While the editor is open, canvas shortcuts are suppressed so that typing `v` does
not switch tools.

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

`Cmd`/`Ctrl` + `F` searches the text of `text` and `sticky` elements and the
`label` of every other shape, case-insensitively.

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
  represent state, `aria-pressed`.
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
