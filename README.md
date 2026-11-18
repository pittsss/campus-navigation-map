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

**Get directions** also offers a second route when there's a sensibly different way (another corridor or
stair, at most 1.6× and 150 m longer): pick **Shortest route** or **Other route**; the other one shows as a
faint grey line.

## Routes between the two campuses

The small map under "BSC Agricultural Laboratory" lists every route, shortest first:

- **Drawn routes** (`campus-route.json`), checked on the ground. Open `map.html?editroute=1` while
  `pnpm dev` is running. Pick **Walk** or **Drive** and a route tab (**+ New route** adds another), then
  click along the real route starting at the main campus (switch to **Satellite** to see footpaths). Click
  the line to add a point in between, drag a point to move it, click a point to delete it. **Save**, then
  commit and push `campus-route.json`.
- **OpenStreetMap suggestions** (`osm-routes.json`, blue dashes), worked out from mapped roads and paths;
  not checked on the ground. Refresh them with `node tools/fetch-osm-routes.mjs`.

Directions stay on this map (no Google Maps): tap a route to use it; **Show route** zooms to the routes, and
**From my location** follows the phone's GPS position live along whichever drawn route is shortest from where
the person is (or the one they tapped), switching if another becomes clearly shorter, with the distance and
time left, a dashed line back to the route when off it, and "You've arrived" at the end. **Drive** appears
once there's a driving route.

## Changing a 3D model

Replace the `.fbx` file in `models/`, then run `pnpm build-models`. The site loads compact copies of
the models (`models/*.model.gz`, about 3× smaller and much quicker to open than the `.fbx`); the tool
makes them, checks each one matches its `.fbx` exactly, and also refreshes the `models/*.fbx.gz`
fallbacks. Models can't use textures (the compact format leaves them out; the tool stops if it finds one).
Commit the new files. To rebuild the main campus paths from the models:
`node tools/generate-paths.mjs` (see the top of that file).

## Publishing

Pushing to the `main` branch on GitHub redeploys the site on Vercel automatically.
