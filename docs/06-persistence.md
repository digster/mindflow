# 6. Persistence

Saving, loading, validation, autosave, recent boards and schema migration.

Reference implementation: [`src/io/`](../src/io/),
[`src/model/document.ts`](../src/model/document.ts),
[`src/model/migrate.ts`](../src/model/migrate.ts).

## Where a board can live

| Origin | Save behaviour |
|---|---|
| **New** (never saved) | Prompts for a location on first save. |
| **Local file** | Overwrites the same file, where the browser allows it. |
| **Google Drive** | Overwrites the same Drive file. See [08-google-drive.md](08-google-drive.md). |

`Cmd+S` always means "save back to where this board came from".
`Cmd+Shift+S` always prompts.

## Local files

Two mechanisms, chosen by feature detection.

### File System Access API — preferred

`showSaveFilePicker` / `showOpenFilePicker` return a persistent **handle**, so
`Cmd+S` overwrites the same file silently, like a desktop application.

Available in Chrome and Edge. Requires a secure context.

Permission on a handle can lapse between sessions or be revoked. MindFlow queries
it before reusing a handle and re-requests if needed, falling back to the picker
rather than failing.

### Download + file input — fallback

Every other browser, including Safari and Firefox. Saving triggers a download;
opening uses a hidden `<input type="file">`.

**Every save produces a new file in the downloads folder.** The web platform
deliberately gives pages no way to write back to a chosen path without the File
System Access API. This difference is visible to the user, so the UI says so
rather than pretending the fallback is a real save.

### Filenames

Derived from `meta.name` with `/ \ ? % * : | " < >` replaced by `-` and whitespace
collapsed, then suffixed `.mindflow.json`. An empty name becomes `board`.

`meta.name` itself is **not** a filename and may contain any character.

## Autosave and recent boards

Every board you work on keeps a copy in the browser, backed by **IndexedDB**.
Those copies are what the **recent-boards menu** lists — click the logo at the
left of the top bar, or run *Recent boards…* from the command palette. The same
menu also starts a new board.

- Debounced 1200 ms after the last edit. A board is also written when it is
  opened, so a board opened from a file or from Drive appears in the menu too.
- **One copy per board**, keyed by the board's `id`. Identical writes are skipped,
  so undo/redo round trips do not rewrite megabytes.
- Each copy carries an **`unsaved`** flag: true while it holds changes that were
  never saved to a file or to Drive. An explicit save **clears the flag rather
  than deleting the copy**, and writes it at once rather than after the debounce.
- **Leaving a board never deletes its copy.** New board, Open, opening another
  recent board and declining startup recovery all leave it in the menu.
- A board with **no elements is not kept**, and a board emptied of every element
  is dropped. A blank board is not worth a row.
- The list is capped at **10 boards**. Past that, boards already saved elsewhere
  are evicted first, oldest first. The oldest board with unsaved work goes only
  once no saved board is left to drop. The board being written is never evicted.
- Removing a board from the menu deletes only this browser's copy. It asks first
  only when the copy is marked unsaved, since only then is it the sole home of
  some work.

### Reopening a board

A copy reopens as a board **with no file behind it**: `Cmd+S` asks where to save
it, as for a new board. Linking it back to the file or Drive entry it came from
would risk quietly overwriting a newer version saved from elsewhere since the
copy was made. A copy marked unsaved reopens with unsaved changes. Any other
copy reopens clean.

### Startup recovery

On startup MindFlow asks *"Recover unsaved work?"* about **one** board: the
board that was on screen when the previous session ended, and only if it had
unsaved changes. Older unsaved boards wait in the menu rather than prompting.
Every board keeps a copy now, so asking about all unsaved work on every launch
would turn a recovery prompt into a nag.

**Start blank** declines without deleting anything: the board stays in the menu,
and the next launch does not ask again. The board on screen is recorded
whenever one is loaded, and once startup has finished deciding.

### Leaving a board with unsaved changes

The prompt depends on whether anything is actually lost:

| Situation | Prompt |
|---|---|
| Storage works and the board has elements | *"Leave unsaved changes?"* — a copy stays in the menu. |
| Storage refused, or the board is empty | *"Discard unsaved changes?"* — the changes really are lost. |

### Storage layout

Database `mindflow`, version 2:

| Store | Key | Holds |
|---|---|---|
| `autosave` | board id | `{ key, contents }`: the serialised board, exactly as Save writes it. Read only when a board is opened. |
| `recent` | `boardId` | `{ boardId, name, savedAt, elementCount, unsaved }`. The menu reads only this, so opening it never deserialises image data. |
| `session` | `lastOpen` | `{ key, boardId }`: the board on screen, for startup recovery. |

A version-1 database held a single record under the key `current`. The upgrade
re-keys it under its board id, marks it unsaved and records it as the last open
board, so the first launch after upgrading offers it back exactly as version 1
would have.

**Why IndexedDB, not localStorage?** localStorage caps out around 5 MB and writes
synchronously on the main thread. A board with two pasted photos exceeds that
immediately, and the write would jank the canvas every time it fired.

If storage fails — quota exhausted, private browsing, a blocked upgrade — autosave
disables itself and says so once, rather than erroring on every subsequent edit.
The menu then says the list is unavailable.

> **From `file://`, it depends on the browser.**
>
> A page opened from disk has an opaque origin. Chromium still grants it
> IndexedDB (the end-to-end suite runs over `file://` and relies on this). Other
> browsers may refuse, in which case the page shows *"Autosave is unavailable"*
> once, at startup, and everything else works normally. Explicit saving with
> `Cmd+S` works from `file://` regardless. If recovery matters to you, use the
> hosted version or `npm run serve`, which have a real origin.

> **This is not a substitute for saving a file.** The browser can evict site
> data, the user can clear it, and it never leaves this machine. The menu says
> so in its footer.

The browser's "unsaved changes" prompt is also wired to the dirty flag. Pending
writes are flushed before the page unloads and also whenever it is hidden,
because a mobile browser discarding a background tab never fires
`beforeunload`.

## Loading

```
parse JSON
  → reject if not an object, or if `type` is not "mindflow.board"
  → migrate, if `schemaVersion` differs from the current version
  → normalise every field, recording warnings
  → de-duplicate element IDs
  → sort by zIndex
  → validate invariants
  → report warnings
```

### Reading is lenient; writing is strict

A core goal is that boards can be authored by *other programs* — scripts,
language models, exporters. Such producers get details wrong: they omit optional
fields, emit a string where a number belongs, or invent an element type.

So the loader:

- **Coerces** what it can. Numeric strings become numbers; `{"x": 1, "y": 2}`
  point objects become tuples.
- **Fills defaults** for anything missing.
- **Records a warning** for anything it changed.
- **Rejects** only what is genuinely unreadable — not JSON, not an object, or not
  `"type": "mindflow.board"`.

The writer always emits fully-populated canonical output. That asymmetry is what
makes the format practical to generate while keeping MindFlow's own files
perfectly consistent.

### Warning levels

| Level | Meaning |
|---|---|
| `info` | Something notable; no data was harmed. Unreferenced files, unknown element types. |
| `warning` | Something was changed to make the document valid. Reassigned IDs, dropped malformed entries. |
| `error` | Something is wrong and was **not** repaired. Dangling bindings, missing images. |

`warning` and `error` are surfaced to the user in a dialog after loading. `info`
is not.

### Repairs applied on load

See the invariants table in
[02-document-format.md](02-document-format.md#invariants) for exactly which
problems are repaired and which are only reported.

Duplicate IDs deserve special mention: two elements sharing an ID break selection,
bindings and undo in ways that are miserable to debug, so it is repaired at the
door with a warning.

### Unknown element types

An element whose `type` this build does not recognise is **kept verbatim** — held
aside during load and written back, in z-order, on the next save.

Forward compatibility matters for a format meant to outlive one app version.
Opening a board that uses a newer element type and saving it must not silently
delete that element. MindFlow cannot draw what it does not know, so it does the
next best thing: it preserves it and says so.

A type a later version **retired** is treated the same way when the board claims
the current version. Only a migration reinterprets a type, and migrations are
chosen by the declared `schemaVersion` — so a 1.4.0 board's `torus` is converted,
while a `torus` in a board declaring 1.5.0 was not written by MindFlow and is
preserved untouched.

## Validation

`validateDocument()` runs on every load and is available to tests. It **reports
rather than repairs** — anything auto-repairable has already been handled during
normalisation, so what surfaces here is genuinely wrong and worth telling the user
about.

The same invariants are expressed three ways: prose in
[02-document-format.md](02-document-format.md#invariants), constraints in the
[JSON Schema](schema/mindflow-1.0.0.schema.json), and this runtime check.

## Schema migration

Every breaking format change ships with a transform from the previous version.
Loading walks the chain from a document's declared `schemaVersion` up to the
current one.

Every version up to 1.4.0 was purely additive, so those steps are identity
transforms. They exist anyway: the runner migrates on *any* version inequality,
and a missing step would make every older board load with a "no migration is
available" warning, which reads as data loss.

**1.5.0 is the first step that transforms anything.** It retired the `sphere`,
`prism`, `torus` and `capsule` types, and converts each one it meets into the flat
shape of its outline — see [CHANGELOG.md](CHANGELOG.md#150--2026-09-22) for the
exact rules.

### Three cases

| Case | Behaviour |
|---|---|
| **Older, chain complete** | Apply each step in turn. Silent success (an `info` warning records what ran). |
| **Older, chain incomplete** | Warn loudly and load as-is. The normaliser's leniency usually still produces something usable. |
| **Newer than this build** | Warn and attempt the load anyway. Unknown element types survive verbatim, so a save-after-open does not destroy data the reader did not understand. |

Migrations receive and return **plain unvalidated objects**, never typed elements,
and run **before** normalisation — so each one sees the document exactly as its own
version wrote it, not a hybrid already partly patched with current defaults. Typing
them against the *current* interfaces would be actively wrong, because those
interfaces describe a shape the old file does not have.

### Adding a migration

1. Bump `CURRENT_SCHEMA_VERSION` in `src/model/types.ts`.
2. Add a `MIGRATIONS` entry in `src/model/migrate.ts`, keyed by the version being
   migrated **from**.
3. Copy `docs/schema/mindflow-<old>.schema.json` and edit the **new copy**.
   Published schemas are immutable — files reference them by URL.
4. Record the change in [CHANGELOG.md](CHANGELOG.md) **with a rationale**.
5. Add a fixture in `test/unit/document.test.ts` proving the old file still loads.

## Export

| Format | Contents |
|---|---|
| **PNG** | Raster, at 1×, 2× or 3×. Optionally transparent. |
| **SVG** | Vector, self-contained (images inlined as data URIs). |
| **`.mindflow.json`** | The board itself — identical to Save. |

Any export can be limited to the current selection. See
[07-rendering.md](07-rendering.md#export) for how each is produced.

## Reading a board without MindFlow

The whole point. A minimal reader:

```python
import json

with open("board.mindflow.json") as f:
    board = json.load(f)

assert board["type"] == "mindflow.board"

# zIndex is the truth; array order is only a convention.
for el in sorted(board["elements"], key=lambda e: e["zIndex"]):
    print(f'{el["type"]:10} at ({el["x"]:>7.1f}, {el["y"]:>7.1f}) '
          f'{el["width"]:>6.1f}x{el["height"]:<6.1f} '
          f'angle={el["angle"]:>5.1f} '
          f'{el.get("text") or (el.get("label") or {}).get("text") or ""}')
```

To *render* one, you additionally need
[04-coordinates.md](04-coordinates.md) for the transforms and
[07-rendering.md](07-rendering.md) for the computed-geometry algorithms. Those two
pages plus the schema are sufficient — that is the standard this documentation
holds itself to.
