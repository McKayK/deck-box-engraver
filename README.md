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
- **SVGs** need filled shapes. Outline-only paths are skipped; in Inkscape use *Path → Stroke to Path*.

In Bambu Studio, opening an inlay 3MF shows "invalid config, load geometry data only". That's expected for any 3MF not saved by Bambu. Click OK, expand the object in the list, and assign a filament to each inlay part.

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
assets/              The deck box model (STL)
samples/             SVGs preloaded on first open
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

### Face geometry

Face positions are hard-coded in the `FACES` table at the top of `src/main.js`, in the box's own coordinates (lying on its back, front = +z, top = −y). Each face has an outward normal `N`, an art "up" vector `U`, its center `c`, its size `w × h`, wall thickness, and any thin strips. To use a different box model, replace the STL in `assets/` and update that table.

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
