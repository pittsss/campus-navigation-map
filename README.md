# BSC Campus Navigator

3D campus map with walking directions for Batanes State College (main campus, 3 floors) and the
BSC Agricultural Laboratory.

## Run it on your computer

```
pnpm dev        # or: node server.js
```

Open http://localhost:3000/map.html (Agricultural Lab: `map.html?site=agri`).

## Edit the walking paths

Open `map.html?edit=1` (or `map.html?site=agri&edit=1`) while `pnpm dev` is running, draw, then **Save**.
The paths are stored in `paths.json`; commit and push it to publish.

## Draw the route between the two campuses

The small map under "BSC Agricultural Laboratory" shows a hand-drawn route (Google's route there is wrong).
Open `map.html?editroute=1` while `pnpm dev` is running. Pick **Walk** or **Drive**, then click along the
real route starting at the main campus (switch to **Satellite** to see footpaths). Click the line to add a
point in between, drag a point to move it, click a point to delete it. Press **Save**: the route is stored in
`campus-route.json`. Commit and push it to publish. The "From main campus" / "From my location" buttons
still open Google Maps for turn-by-turn navigation.

## Changing a 3D model

Replace the file in `models/`, then run `pnpm compress-models` (the site loads the compressed
`models/*.fbx.gz` copies). To rebuild the main campus paths from the models:
`node tools/generate-paths.mjs` (see the top of that file).

## Publishing

Pushing to the `main` branch on GitHub redeploys the site on Vercel automatically.
