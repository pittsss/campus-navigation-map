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

## Changing a 3D model

Replace the file in `models/`, then run `pnpm compress-models` (the site loads the compressed
`models/*.fbx.gz` copies). To rebuild the main campus paths from the models:
`node tools/generate-paths.mjs` (see the top of that file).

## Publishing

Pushing to the `main` branch on GitHub redeploys the site on Vercel automatically.
