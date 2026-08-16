<div align="center">

# MindFlow

**A digital whiteboard that runs from a single HTML file.**

No server. No build to deploy. No account. Your boards are plain, documented JSON
files that you own.

</div>

---

MindFlow is an infinite-canvas whiteboard in the spirit of Apple Freeform,
Excalidraw and tldraw. It has no real-time collaboration — it is a tool for
thinking, and a board is a file.

Its distinguishing feature is the **save format**. `.mindflow.json` is fully
specified in [`docs/`](docs/), down to the algorithms behind computed geometry, so
a board can be read, written, validated and rendered by programs that are not
MindFlow. Automated tests fail the build if the code and that specification ever
drift apart.

## Features

**Canvas** — infinite pan and zoom, grid with snapping, alignment guides.

**Tools** — select, pan, rectangle, ellipse, line, arrow, freehand, text, sticky
note, image, eraser.

**Editing** — move, resize and rotate (including correct rotated resizing),
multi-select, marquee, grouping, align and distribute, z-order, in-place text
editing, full undo/redo, clipboard with cross-tab support, and a style clipboard
that copies appearance without content.

**Getting around** — a command palette (`Cmd K`), text search across the board
(`Cmd F`), and a right-click context menu.

**Connectors** — arrows that bind to shapes and re-route automatically when those
shapes move. Straight, curved or elbow routing; five arrowhead styles.

**Files** — save and load `.mindflow.json` locally, IndexedDB crash recovery
(hosted only — browsers block IndexedDB on `file://`), drag-and-drop to open,
export to PNG, SVG or JSON.

**Google Drive** — optional. Uses only the non-sensitive `drive.file` scope and
works out of a single folder it creates.

## Try it

**Hosted:** open the GitHub Pages URL for this repository.

**Locally, with no tooling at all:** download `index.html` and double-click it.
That single file is the entire application.

**From source:**

```bash
npm install && npm run build
```

Then open `index.html`.

## How it works without a server

`index.html` is a self-contained build artifact with all JavaScript and CSS
inlined. That is not merely convenient — it is required:

> Browsers fetch `<script type="module">` with CORS semantics, and a page opened
> from `file://` has an opaque origin, so every module fetch is blocked. An app
> that loads code from separate module files **cannot** be run by double-clicking.

Inlining sidesteps that entirely, so the same artifact works from `file://`, from
a local server, and from GitHub Pages unchanged. The end-to-end suite loads the
built file over `file://` and asserts that zero external requests are made, so
this cannot silently regress.

## The save format

A board is a flat, ordered list of elements. Every element carries its complete
resolved state — nothing is inherited from a parent, a theme or a document
default — so any single element is interpretable in isolation.

```json
{
  "type": "mindflow.board",
  "schemaVersion": "1.0.0",
  "elements": [
    {
      "id": "el_q2WikW58Aw",
      "type": "rectangle",
      "x": 60, "y": 90, "width": 140, "height": 70,
      "angle": 0, "zIndex": 1000, "opacity": 1,
      "locked": false, "visible": true, "groupId": null,
      "style": {
        "stroke": "#1e1e1e", "strokeWidth": 2, "strokeStyle": "solid",
        "fill": "#a5d8ff", "fillStyle": "solid", "roughness": 0
      },
      "label": null, "meta": {}, "cornerRadius": 8
    }
  ]
}
```

Reading one takes about six lines:

```python
import json

board = json.load(open("board.mindflow.json"))
assert board["type"] == "mindflow.board"

for el in sorted(board["elements"], key=lambda e: e["zIndex"]):
    print(el["type"], el["x"], el["y"], el["width"], el["height"])
```

### Why it is documented this thoroughly

Documenting *fields* is easy. The trap is documented fields whose **values are
computed**: an arrow storing `"anchor": {"mode": "auto"}` records *that* it
attaches to a shape, not *where* — the position is derived from the target's
current geometry.

So [`docs/07-rendering.md`](docs/07-rendering.md) specifies the algorithms too:
auto-anchor resolution, elbow routing, curve smoothing, text wrapping, arrowhead
geometry. Without those, a file containing a bound arrow could only be rendered by
MindFlow itself, which would defeat the point.

**Start here:** [`docs/README.md`](docs/README.md) ·
[format](docs/02-document-format.md) · [elements](docs/03-elements.md) ·
[geometry](docs/04-coordinates.md) · [rendering algorithms](docs/07-rendering.md) ·
[JSON Schema](docs/schema/mindflow-1.0.0.schema.json)

## Google Drive

Optional, and MindFlow is fully functional without it.

MindFlow requests exactly one OAuth scope — `drive.file` — which Google
classifies as **non-sensitive**. It grants access only to files the application
itself created.

**MindFlow can** create a folder, and read, write and list the boards it created
inside it.
**MindFlow cannot** see anything else in your Drive.

The tradeoff, stated plainly: a file you drop into the MindFlow folder by hand
through drive.google.com is invisible to the app, because MindFlow did not create
it. Open it locally with `Cmd+O` and save it to Drive instead.

Google's script loads only after you click "Connect Drive". Tokens live in memory
and are never persisted. Drive cannot work from `file://` — a double-clicked page
reports its origin as `null`, which Google will not accept as an authorised
origin.

Setup is documented in [`docs/08-google-drive.md`](docs/08-google-drive.md).

## Keyboard shortcuts

`Cmd` on macOS, `Ctrl` elsewhere. Press the `?` button in the app for the full
list.

| | |
|---|---|
| `V` `H` `R` `O` `L` `A` `P` `T` `N` `E` | Select, pan, rectangle, ellipse, line, arrow, draw, text, note, eraser |
| `Space` + drag · `Cmd` + scroll | Pan · Zoom |
| `Cmd` `K` / `Cmd` `F` | Command palette / Find on board |
| `Cmd` `Z` / `Cmd` `Shift` `Z` | Undo / Redo |
| `Cmd` `Alt` `C` / `Cmd` `Alt` `V` | Copy / paste style |
| `Cmd` `G` / `Cmd` `Shift` `G` | Group / Ungroup |
| `Cmd` `[` / `Cmd` `]` | Send backward / Bring forward |
| `Cmd` `0` / `Cmd` `1` | Reset zoom / Zoom to fit |
| `Cmd` `S` / `Cmd` `O` / `Cmd` `Shift` `E` | Save / Open / Export |
| `Shift` / `Alt` while dragging | Constrain / From centre, or suspend snapping |
| Right-click | Select a locked element, so it can be unlocked |

A locked element is scenery — clicks pass through it and a marquee ignores it.
Right-click is how you get one back: it selects the locked element and the style
panel collapses to a single **Unlock** button.

## Development

```bash
npm install

npm run dev         # watch and rebuild; open index.html directly
npm run serve       # watch + http://localhost:8000 (needed to test Drive)
npm run build       # produce the single-file index.html

npm run typecheck   # esbuild does not type-check — this does
npm test            # unit + contract tests
npm run test:e2e    # Playwright against the built file
npm run check       # typecheck + test + build
```

`index.html` is a **committed build artifact**. Rebuild and commit it alongside
any `src/` change.

Architecture and rationale: [ARCHITECTURE.md](ARCHITECTURE.md).
Adding an element type: [`docs/09-extending.md`](docs/09-extending.md).

### The contract test

`test/unit/contract.test.ts` fails the build when the element registry, the JSON
Schema and `docs/03-elements.md` disagree, when an example board stops validating,
or when a round trip stops being stable. If you change the format, change all
three — the test will tell you if you missed one.

## Deployment

GitHub Pages, **source: `main` branch, `/` (root)**.

> Do not point Pages at `/docs` — that folder holds the format documentation, and
> Pages would publish the docs instead of the app.

`.nojekyll` at the root disables Jekyll processing.

## What MindFlow deliberately isn't

- **Not collaborative.** No CRDT, no presence, no server. A board is a file.
- **Not a cloud service.** There is no MindFlow backend. Your data goes to your
  disk or your Drive, and nowhere else.
- **Not tracked.** No analytics, no telemetry, no external requests at all until
  you explicitly connect Drive.

## Roadmap

Considered, in rough order — see
[`docs/CHANGELOG.md`](docs/CHANGELOG.md#unreleased):

- `diamond` and `frame` element types
- Hand-drawn rendering (`style.roughness` is already reserved in the format)
- Google Picker, to lift the `drive.file` limitation
- Laser pointer and presentation mode

## License

[MIT](LICENSE) © digster
