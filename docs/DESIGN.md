# TraceNaut design system

Goal: maximum understanding through simple, polished visuals. A visual element earns its place only if it helps a student understand where code runs, what it does, or how sure TraceNaut is.

## Brand

The mark is three stacked glass layers with a pointer on top: you point at something on the page and see the layers of the running system beneath it (browser, server, database). It is raster artwork (glossy glass does not reduce to flat vector shapes), so the PNGs in `packages/assets/src/brand` are the source: `tracenaut-mark.png` (master, transparent background), downscaled `mark-16…512.png` (the 16–48 px ones lightly sharpened), and `mono-light/dark-256.png` single-colour versions. `npm run assets` wraps them as `brand-mark`, `brand-favicon`, `brand-mono-light/dark` and `brand-lockup-light/dark` SVGs in `packages/assets/dist/icons`, copies PNG exports to `packages/assets/dist/brand`, and refreshes the extension icons. At 16 px the mark reads as a blue stack with a pointer; the pointer is the first detail to go.

## Icon system (2.5D)

All TraceNaut icons are generated from shared isometric primitives (`scripts/icons/iso.mjs`: boxes, cylinders, extrusions, badges, spheres), so geometry, lighting and colour follow one rule set. They are never drawn one by one.

```bash
npm run assets                                  # icons + logo tiles + manifest + gallery → packages/assets/dist
open packages/assets/dist/gallery.html          # every asset, light and dark, with licences and support levels
node scripts/icons/export-png.mjs request 512 x.png      # transparent PNG export of an icon
node scripts/coverage.mjs                       # technology × support-level matrix (docs/COVERAGE.md)
```

| Rule | Value |
|---|---|
| Projection | true isometric: x′ = (x − y)·cos 30°, y′ = (x + y)·sin 30° − z |
| Light | from the top-left: top faces lightest, left faces mid, right faces darkest |
| Depth | soft vertical gradient per face, a light rim on top edges, a thin dark outline, one radial contact shadow; no filters |
| Glyphs | projected onto faces with affine matrices; status glyphs (✓ × ?) stay upright so they read at 20 px |
| Canvas | 32 × 32, transparent, centred on the footprint; numbers rounded without merging adjacent path values |
| Colour | one hue per meaning; faces derive from it by mixing with white/black |

**Two families, never mixed up.**
- *Conceptual icons* (57): places, steps, certainty, technology kinds and ideas (browser, server, database, request, response, middleware, condition, cache, queue, auth…). They explain *what kind of thing* something is.
- *Logo tiles* (112): the official logo of a specific technology, from Simple Icons 16.35.0, placed unaltered on a neutral isometric tile. The logo path is never redrawn or recoloured beyond the brand colour Simple Icons provides. Each tile records its source, licence and brand-guidelines link; the gallery lists them, and concept cards show a trademark note. Logos under non-commercial licences (Vue.js, Sass: CC BY-NC-SA) are excluded; technologies without a usable logo (Java, C#, AWS, Azure, Heroku, Playwright, DynamoDB) get a conceptual icon instead.

| Meaning | Hue | Examples |
|---|---|---|
| Browser / frontend | indigo `#7c7cff` | browser, component, interaction, code-browser, update |
| Server | teal `#2ec4a0` | server, code-server, middleware |
| Database | amber `#f2a03d` | database |
| Network | cyan `#38bdf8` | request, response, network, protocol |
| Certainty | green / blue / amber / slate | happened, in the code, likely, can't tell; plus fail (rose) |
| Technology kinds | purple, teal, blue, green, orange, pink | language, library, framework, runtime, data, api |

Distinctions that must survive at 22 px: request and response use large opposite arrows (cyan leaving, green returning); browser, update and API have different silhouettes; browser code and server code carry shape cues, not only colour; the condition icon is an upright flowchart diamond.

**Delivery.** Icons are SVG files served by the daemon at `/assets/icons/<name>.svg?v=<version>` with an immutable cache, loaded lazily by `<img>` (`Icon3D`). The client bundle contains no icon data (it went from 191.6 KB to 137.8 KB raw while gaining features). Average icon size 2.4 KB, 420 KB for the whole set; the brand mark is 33 KB (it embeds a 128 px PNG) and is fetched once. An icon always sits next to text; it never carries meaning alone.

## Information hierarchy (Guided mode)

1. **Answer first.** The inspected element (a simplified drawing from its live styles), the question, and a one-sentence answer. The full explanation is one click away.
2. **Behaviour.** *Step by step*: steps grouped by place (browser, server, database). Each row is a 2.5D icon with a certainty pip, a title and one line of detail. Crossings between places (requests, answers) are their own rows and name their protocol.
3. **Technologies.** Listed once per place in its header; each chip says what kind of thing it is (language, framework, runtime…) and explains itself on hover or click.
4. **Implementation, on request.** An expanded step shows what happens, the data, the code that runs, how sure TraceNaut is, and buttons for the code (both sides of a crossing) and Technical details.
5. **Layers.** A compact 2.5D view of the same journey: your element on top of stacked layers (browser, server, database), with connections whose line style states their certainty. Each request gets its own lane (request ↓, answer ↑, and "then: the page updates" when it does); alternative answers are drawn as green/red branch chips; the server layer lists the middleware that runs before the route; a layer TraceNaut cannot see into is drawn as a dashed outline. Beyond two requests, the rest are behind "Show more". Selecting a layer or connection explains it and links back to the step.
6. **Folding.** In recordings, runs of code that only "also ran" (animation frames, timers, effects that send nothing) fold into one row that says so; it opens on request.
7. **Honest causality in recordings.** Steps say how they relate to your action: run by it; "A moment later, the code it scheduled" (a debounce or timer the element's code sets up, marked likely); "After the redraw" (effects); "Also ran during the recording" (folded). A request a server makes to itself or to another service, a page change through a router, a full page load ("the recording stops here") and messages on a live connection each have their own plain step.
8. **Home view.** "This project is built with": the project's technologies found in manifests and files, split into those TraceNaut follows through the code and those it only recognises. Each chip explains how TraceNaut knows.

Certainty is a pip on each step icon (filled ✓ = happened, ring = in the code, dashed = likely, dotted = can't tell) and the rail between steps uses the same line styles. The meaning is explained on demand ("How sure?"), not by a permanent legend.

## Layout rules

- One scroll container per panel; no nested vertical scrolling (code shows a window of lines with "Show all").
- Overscroll is contained, so the page behind never scrolls instead of the panel.
- A fade and a small ↓ button signal more content below (macOS hides scrollbars).
- Expanded steps appear in place (fade only) and are scrolled into view.
- Concept cards are measured, kept inside the window, scroll internally if tall, and follow their term while the panel scrolls.
- The panel is clamped to the window. At 980 px and wider it docks beside the page; below that it overlays.

## Motion

150–220 ms, opacity/transform only, never layout. Nothing runs while idle; `prefers-reduced-motion` turns all motion off. Verified by `tests/e2e/guided.spec.mjs`.
