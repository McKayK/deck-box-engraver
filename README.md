# Deck Box Engraver

A browser tool for putting SVG artwork on a 3D-printed MTG Commander deck box. Drop an SVG on any face, drag it into place, and download a print-ready file:

- **Engrave**: the design is cut into the box. Exports an **STL**.
- **Color inlay**: the design is cut into the box and filled with a separate part you can give its own filament in the slicer. Exports a **3MF** (one object, one part per inlay).

Everything runs locally in the browser. The build produces **one self-contained HTML file** (`docs/index.html`, about 2 MB) with the 3D engine, geometry kernel, box model and sample art all inlined. Open it by double-clicking, or host it anywhere static.

## Using it

- **Faces**: left, right, back, top, bottom. The front is the open top-loader slot.
- **Move**: drag the design on the model (it stays flat on its face), use the sliders or number boxes, or nudge with the arrow keys (Shift = 5 mm).
- **Resize**: Size slider, or Shift+scroll over the model. 100% fits the full face.
- **Trimming**: anything past the dashed face outline is cut off (shown as a faint ghost).
- **Line weight**: thickens or thins every line in the design, baked into the export. Use +0.2 to +0.3 mm for fine art on a 0.4 mm nozzle.
- **Warnings**: flags cuts that would leave less than 0.4 mm of wall, including the thin lid rail along the front edge of the sides (1.32 mm) and the back (1.05 mm).
- **SVGs**: filled shapes and colored outlines both work (outlines are converted to filled shapes). Gradients are flattened to one color. SVGs that only contain an embedded picture can't be engraved; trace them first (Inkscape: *Path → Trace Bitmap*).

### Multi-color SVGs

When an SVG has more than one fill color, the Engrave / Color inlay switch is replaced by a **Colors** panel:

- **Automatic setup**: a background color (one that covers most of the design's edge) is set to *Box color*, and the remaining colors are merged down to **4 filaments** by combining the most similar colors.
- **Filaments − / +**: merge into fewer filaments, or split back out (up to 4). **Auto-assign** redoes the automatic setup.
- **Each color** can be moved to any filament, to *Box color (skip)*, or to *Engrave only* (cut, no filament).
- **Each filament** has a preview color and its own **line weight**. A thickened color wins over its neighbors; a thinned one gives its space to them.
- **Specks**: color islands smaller than this area (mm²) are absorbed by the surrounding color. Hairline seams between colors are closed the same way.
- **Click a color on the model** to jump to its filament in the panel.
- Stacked shapes are resolved like the SVG draws them: shapes later in the file cover earlier ones.
- The export has one part per filament per face (for example `jace (Back) - Filament 2 #054a72`).

Upright faces (sides, top, bottom) need a filament change per color on every layer through the design; the back prints flat, so colors only change in its first few layers. The panel notes this for each face.

In Bambu Studio, opening an inlay 3MF shows "invalid config, load geometry data only". That's expected for any 3MF not saved by Bambu. Click OK, expand the object in the list, and assign a filament to each inlay part.

## Box models

Each deck box is a **profile** in the `PROFILES` list at the top of `src/main.js`: an STL file name (from `assets/`) and a table of faces. When there's more than one profile, a **Box model** picker appears above the face list. Switching keeps designs on faces both boxes share; designs on faces the other box doesn't have are kept and come back when you switch back.

To add a box: drop its STL in `assets/`, add a profile with its faces (see *Face geometry* below), and rebuild. Every STL in `assets/` is embedded automatically.

## Building

```bash
npm install
npm run build        # writes docs/index.html
```

Requires Node 18+.

## Project layout

```
src/main.js          App code: scene, SVG parsing, placement, drag, build, STL/3MF writers
src/template.html    Page markup and CSS, with %%PLACEHOLDERS%% the build fills in
build.mjs            esbuild bundle + inlining into docs/index.html
assets/              Deck box models (STL), one per profile
samples/             SVGs: the four LOTR designs preload on first open; jace.svg and uncle-iroh.svg are multi-color test files
docs/index.html      Built output (committed so GitHub Pages can serve it)
Dockerfile           Two-stage build: node builds the page, nginx serves it
nginx.conf           Container's nginx config (gzip, no-cache)
docker-compose.yml   Runs the container on port 8090
```

## How it works

- **three.js** draws the preview. Designs are thin decals on each face, and moving or resizing just changes a transform. Trimming at the face edge uses GPU clipping planes, so slider changes are instant.
- **manifold-3d** (C++ compiled to WebAssembly) does the geometry. It turns SVG paths into 2D cross-sections, handles line-weight offsets and trimming, and runs the final `box − cutters` (engrave) or `box ∩ cutter` (inlay) booleans. Its output is always watertight.
- The wasm binary and the box STL are embedded as base64 and passed straight in, so the page never fetches anything. (Google Fonts is the only external link, and it falls back to system fonts offline.)
- SVG outlines are simplified at 0.01 mm, and the final mesh gets a light cleanup. Without that, the micro-edges from finely sampled curves collapse into non-manifold edges once written to STL.
- Multi-color pipeline (per face, cached until something changes): visible region per color → group by filament → drop specks → per-filament line weight (thicker wins) → neighbors grow in small steps to fill gaps → colors separated by 0.008 mm so each part is a clean solid. The box loses the whole pocket in one cut, and each filament becomes `box ∩ extruded region`.

### Face geometry

Each profile's `faces` table is in the box's own coordinates (the top loader lies on its back, front = +z, top = −y). Each face has an outward normal `N`, an art "up" vector `U`, its center `c`, its size `w × h`, wall thickness, default depth, and any thin strips (local rectangles with a thinner wall, used for warnings).

## Hosting with Docker

The image builds the app, then serves the single HTML file with nginx (gzip on, about 2 MB down to under 1 MB over the wire). No Node at runtime.

```bash
docker compose up -d --build     # serves on http://<server>:8090
```

After changing the code or SVG samples, run the same command again to rebuild and restart.

Behind an existing Nginx reverse proxy, add a server block pointing at the container:

```nginx
server {
    listen 443 ssl;
    server_name engraver.example.com;
    # ssl_certificate / ssl_certificate_key: same as your other sites

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
    }
}
```

If the proxy itself runs in Docker on a shared network, drop the `ports:` mapping in `docker-compose.yml`, join that network, and use `proxy_pass http://deck-box-engraver:80;` instead.

## Hosting on GitHub Pages

Push the repo, then go to **Settings → Pages → Build and deployment**, choose *Deploy from a branch*, select `main` and the `/docs` folder. The tool will be live at `https://<username>.github.io/<repo>/`.
