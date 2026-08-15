# Prompt log

A record of the prompts that drove this project, kept for context and
reproducibility.

---

## 2026-08-15 — Initial build

> - i want to create a digital whiteboarding tool ala freeform + excalidraw + tldraw.
> - it wont have concurrent collabaration features.
> - it will be html only and should be runnable without a server(we will be hosting it via static github pages).
> - add a nojekyll file as well.
> - the way we want to go about the feature scope is to start with the basic features and add more as we move ahead.
> - give me the options for the feature set to start with.
> - we should be able to save and load indivdual project files.
> - the complete interpretation/architecture of our app(objects, positioning, attributes, interactions etc) including the save files should be well documented inside a 'docs' folder(any new features or changes should always update these contract docs, update this in the project claude file).
> - the aim is to clearly interpret the save files and the app as a whole outside of the running app(for extensability and documentation purposes), think programmatic compatibility with llms.
> - add a google drive integration as well, make sure we only ask for as little permissions as possible to get the integration working, it should be able to work off a single folder saved in the drive that we last used.

### Decisions taken in response

Four options were presented and chosen:

| Question | Choice |
|---|---|
| V1 feature scope | **Standard whiteboard** — core canvas plus sticky notes, images, grouping, snapping, bound connectors, shape labels, PNG/SVG export |
| Build approach | **Bundle to a single file** — TypeScript ES modules in `src/`, esbuild inlines everything into one `index.html` |
| Renderer | **Canvas 2D** with a DOM overlay for text editing |
| Drive scope | **Auto-created folder only**, `drive.file` scope, OAuth Client ID only |

### Two constraints surfaced during planning

1. **`file://` blocks ES modules.** Browsers fetch module scripts with CORS
   semantics and a local page has an opaque origin, so "runnable without a
   server" rules out shipping module scripts. This dictated the single-file
   inlining build.
2. **OAuth cannot work from `file://`.** A double-clicked page reports origin
   `null`, which Google will not accept. Drive is therefore an HTTP(S)-only
   feature — documented as a boundary rather than worked around.

> implement the plan.

Delivered: the full application, the `docs/` contract, a JSON Schema with
examples, 183 unit/contract tests and 23 end-to-end tests against the built
artifact.
