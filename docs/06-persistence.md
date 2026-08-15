# 6. Persistence

Saving, loading, validation, autosave and schema migration.

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

## Autosave

Crash recovery, backed by **IndexedDB**.

- Debounced 1200 ms after the last edit.
- Stores one record — the current board, serialised.
- Identical writes are skipped, so undo/redo round trips do not rewrite megabytes.
- Cleared after any explicit save.
- On startup, an existing record prompts *"Recover unsaved work?"*.

**Why IndexedDB, not localStorage?** localStorage caps out around 5 MB and writes
synchronously on the main thread. A board with two pasted photos exceeds that
immediately, and the write would jank the canvas every time it fired.

If storage fails — quota exhausted, private browsing, a blocked upgrade — autosave
disables itself and says so once, rather than erroring on every subsequent edit.

> **Autosave does not work from `file://`.**
>
> Chrome and most other browsers block IndexedDB on `file://` pages, because such
> a page has an opaque origin and there is no meaningful security boundary to
> scope the database to. A double-clicked MindFlow page therefore shows
> *"Autosave is unavailable"* once, and everything else continues to work
> normally.
>
> This is a browser policy, not something MindFlow can work around. If crash
> recovery matters to you, use the hosted version or `npm run serve` — both have
> a real origin. Explicit saving with `Cmd+S` works from `file://` regardless.

> **Autosave is not a substitute for saving a file.** It exists so a crashed tab
> or a closed laptop does not lose work. The UI describes it as recovery, never as
> a save.

The browser's "unsaved changes" prompt is also wired to the dirty flag, and a
final autosave is flushed before the page unloads.

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

There are **no migrations yet** — 1.0.0 is the first published version. The
machinery exists anyway, complete with tests, because retrofitting a migration
system *after* files exist in the wild is how formats get stuck.

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
5. Add a fixture in `test/unit/migrate.test.ts` proving the old file still loads.

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
