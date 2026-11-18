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
`campus-route.json`. Commit and push it to publish.

Directions stay on this map (no Google Maps): **Show route** zooms to the drawn route, and **From my location**
follows the phone's GPS position along it live, with the distance and time left, a dashed line back to the
route when off it, and "You've arrived" at the end. The **Drive** option only appears once a driving route
has been drawn.

## Changing a 3D model

Replace the `.fbx` file in `models/`, then run `pnpm build-models`. The site loads compact copies of
the models (`models/*.model.gz`, about 3× smaller and much quicker to open than the `.fbx`); the tool
makes them, checks each one matches its `.fbx` exactly, and also refreshes the `models/*.fbx.gz`
fallbacks. Models can't use textures (the compact format leaves them out; the tool stops if it finds one).
Commit the new files. To rebuild the main campus paths from the models:
`node tools/generate-paths.mjs` (see the top of that file).

## Publishing

Pushing to the `main` branch on GitHub redeploys the site on Vercel automatically.
