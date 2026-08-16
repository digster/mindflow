# MindFlow documentation

This folder is the **contract**. It specifies MindFlow's data model, save format,
geometry, rendering and interaction behaviour precisely enough that you can read,
write, validate and render a `.mindflow.json` board **without running MindFlow**.

That goal is not aspirational — it constrains the design. Wherever a stored value
is *computed* rather than literal (an auto-anchored connector endpoint, a wrapped
line of text, an elbow route), the algorithm is specified here, not left as an
implementation detail. A format that only its own application can interpret is not
a format.

## Reading order

| # | Document | What it answers |
|---|---|---|
| 1 | [01-overview.md](01-overview.md) | What is a board? What is an element? The mental model in one page. |
| 2 | [02-document-format.md](02-document-format.md) | The top-level file structure, invariants, and the design rules behind them. |
| 3 | [03-elements.md](03-elements.md) | Every element type, every field, every default. The reference table. |
| 4 | [04-coordinates.md](04-coordinates.md) | Scene vs screen space, rotation, bounding boxes, hit-testing. |
| 5 | [05-interactions.md](05-interactions.md) | Tools, gestures, keyboard shortcuts, selection and snapping behaviour. |
| 6 | [06-persistence.md](06-persistence.md) | Saving, loading, autosave, validation and schema migration. |
| 7 | [07-rendering.md](07-rendering.md) | Paint order, style semantics, and the computed-geometry algorithms. |
| 8 | [08-google-drive.md](08-google-drive.md) | The Drive integration, its permission model, and its limits. |
| 9 | [09-extending.md](09-extending.md) | Adding an element type end to end. |

Plus:

- [CHANGELOG.md](CHANGELOG.md) — schema version history and migration notes.
- [schema/mindflow-1.2.0.schema.json](schema/mindflow-1.2.0.schema.json) — machine-readable JSON Schema (draft 2020-12), current version. Earlier versions stay published and unchanged; see the changelog.
- [schema/examples/](schema/examples/) — valid boards covering minimal, complete, connector-heavy and frame cases.

## If you only read one thing

A MindFlow board is a JSON object with a **flat array of elements**. Every element
carries its complete, resolved state — nothing is inherited from a parent, a theme
or a document default. Coordinates are in scene units, angles are in **degrees**
(clockwise, about the element's centre), and paint order is set by a fractional
`zIndex`.

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

## Rules for changing this documentation

These are enforced, not merely requested.

1. **The format is specified in three places that must agree.** The prose here,
   `schema/mindflow-*.schema.json`, and `src/model/types.ts`. Change one, change
   all three, in the same commit.
2. **Published schemas are immutable.** Saved files reference a schema by URL. To
   change the format, add a new version — never edit a released one.
3. **Specify algorithms, not just fields.** If a reader cannot reproduce a
   rendered result from the file plus this documentation, the documentation is
   incomplete.
4. **`test/unit/contract.test.ts` enforces what it can.** It fails the build when
   the element registry and the JSON Schema disagree, and when the example files
   stop validating or stop round-tripping. It cannot check prose — that part is
   on the author.

## Conventions used throughout

- **MUST / SHOULD / MAY** carry their usual [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) meanings.
- **Writer** means any program producing a `.mindflow.json` file; **reader** means
  any program consuming one. MindFlow itself is both.
- Field paths are written as `elements[3].style.stroke`.
