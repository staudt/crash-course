# Desert — vehicular destruction game

Original Carmageddon-style car-smashing game in a low-poly desert (orange dunes, rock walls, blue sky). three.js + Rapier physics + TypeScript, built with Vite, deployed to GitHub Pages.

Camera is a **fixed 3/4 overhead view that never rotates** (the default); **C** toggles a traditional chase view behind the car (remembered in `localStorage['desert.camera']`). It follows the car from a distance, so cars can stay simple and low-poly. The star feature is **visible damage**: car bodies dent per vertex and parts (bumpers, hood, doors, wheels) break off as physics debris.

Roadmap: M1 sandbox (driving + destruction) → M2 time trial on a ~7 km circuit → **M3 races against 5 AI rivals (current)** → dash ability → roguelike runs (upgrades as stat modifiers). The user dislikes horde games and wants purpose; Atari *Combat*-style battles and destruction-derby racing are welcome directions.

## Commands
- `npm run dev`: local dev server
- `npm run build`: typecheck + production build to `dist/` (relative base `./`, works under any Pages path)
- `npm run preview`: serve the build
- `npm run check`: `tsc --noEmit` (TypeScript 7)
- `npm test`: Vitest (node environment, `src/**/*.test.ts`)

Deploy: push to `main`. `.github/workflows/deploy.yml` tests, builds and deploys. In the repo settings, Pages source must be "GitHub Actions".

## Architecture
| Module | Responsibility |
|---|---|
| `src/main.ts` | `await initPhysics()` then `new Game()` |
| `src/game/Game.ts` | renderer, scene, world building, cars (`spawnCar`/`removeCar`/`spawnPlayer`), fixed-timestep loop (60 Hz physics, render interpolation), FX, camera |
| `src/game/RaceDirector.ts` | race orchestration: mode (`race` vs `timetrial`, T toggles), grid, per-racer `Race` trackers, rival driving and rescues, standings, finish + results, race HUD, best-lap storage |
| `src/core/Physics.ts` | Rapier world (gravity −20 for arcade feel), contact-force dispatch, collider→owner map |
| `src/core/Input.ts` | keyboard → `DriveInput` |
| `src/core/types.ts` | `DriveInput` (`throttle`, `steer`, `brake`, `handbrake`): the one control interface for player, AI and replays |
| `src/core/CameraRig.ts` | follow camera with two modes. `fixed`: the 3/4 overhead view; `setFraming(zoom, lookX, lookZ)` adds race framing on top of the follow (lead + lean capped at `maxLean` 16 m). `chase` (`CHASE_CONFIG`): 9 m behind and 3.3 m up, swinging round at `yawRate`, partly following the direction of travel so drifts show, fov 60 → 72 with speed, never below the terrain (`setGround`). Snap with `Game.snapCamera()` after teleports, so the chase view starts behind the car |
| `src/game/CameraFraming.ts` | pure: zoom in on a rival beside you (−28 m), widen (up to +52 m) and lean toward one up to 90 m away, lean and widen (+32 m) toward sharp bends ahead at speed (`FRAMING_CONFIG`, live in Tuning → Camera → Framing). Camera distance is clamped to ≥ 20 m |
| `src/world/TerrainData.ts` | pure heightfield + sand-softness generation and sampling (no three) |
| `src/world/Road.ts` | pure: `buildElevation` (road height profile) + `carveRoad` (cuts the road into the heightfield, firms its sand) |
| `src/race/TrackPath.ts` | pure closed centreline: authored as a corner polygon rounded with arcs, sampled every ~2 m; `project`, `pointAt`, `tangentAt`, `curvatureAt`, `heightAt`, checkpoints, jumps |
| `src/race/tracks.ts` | track definitions (`DUNE_LOOP`) |
| `src/race/Race.ts` | pure time-trial state: countdown, ordered gate crossing, laps, splits, best lap, wrong way, respawn pose |
| `src/race/TrackProps.ts` | road ribbon mesh (fades out over sand), checkpoint gates (post colliders), start/finish chequer, knockable marker stakes (sleeping dynamic bodies, one InstancedMesh; every 20 m on sand) |
| `src/race/GuideArrow.ts` | the guide arrow, pointing from the player's car toward `Race.guidePoint` (the route 45 m ahead, or the next gate once it's closer). It also previews the next bend (`TrackPath.nextBend`: radius ≤ 150 m within 150 m; same-direction bends < 60 m apart merge). The shaft curves by the bend's turn (`turnArrowGeometry`, cached per 10°), and the colour goes yellow (R ≥ 120) → orange → red (R ≤ 35). In the overhead view it is placed near the screen edge (the car→target screen direction meets an inset box, then unprojected onto the ground). In the chase view it floats 9 m ahead of the car, tilted up toward the camera and drawn 2× bigger. It is drawn over everything and scaled by its camera distance for a constant on-screen size. `RaceDirector.lateUpdate` updates it after the camera moves. **The track itself has no curve markings**: the arrow is the corner warning |
| `src/race/TrackMarkings.ts` | jump stripes across the lip + yellow ramp edge lines (bend chevrons and boards were removed in favour of the guide arrow) |
| `src/ai/Autopilot.ts` | pure-pursuit driver producing `DriveInput` along a TrackPath; per-driver `tune`, line `offset`, `pace` |
| `src/ai/Rival.ts` | AI racer brain: `RIVALS` personalities (driving style + matching car `StatModifier`s), overtaking, no rear-ending, apex cutting, anger/revenge/bullying, rubber-banding, rescue decision; `wasHit` contact blame |
| `src/ui/RaceHud.ts` | timer, lap/CP/best/last line, position, split flashes, countdown/GO, WRONG WAY, rotated minimap with opponent dots, results panel |
| `src/world/Terrain.ts`, `Rocks.ts`, `Environment.ts` | world meshes (terrain in 64-cell tiles for culling) + static colliders, sky/fog/lights |
| `src/vehicle/CarStats.ts` | **all car tunables** + `CarDims` + `StatModifier`/`applyModifiers` (future upgrades) |
| `src/vehicle/CarModel.ts` | contract between the mesh builder and `Car` (parts, wheel pivots) |
| `src/vehicle/CarBuilder.ts` | procedural low-poly car meshes |
| `src/vehicle/Car.ts` | chassis body + Rapier `DynamicRayCastVehicleController` + arcade assists + damage |
| `src/vehicle/Deformer.ts` | pure `applyDent()` on `Float32Array` vertex positions |
| `src/fx/*` | pooled particles (dust/sparks/smoke), debris bodies |
| `src/ui/Hud.ts`, `src/debug/Tuning.ts` | DOM HUD, lil-gui tuning panel (backtick toggles) |

### Key designs
- **Axes:** car forward is +Z, up is +Y, left is +X. The vehicle controller uses `setIndexForwardAxis = 2`, and the wheel axle is (−1,0,0).
- **Impact detection:** damage is driven by the chassis' *sudden velocity change per physics step* (minus gravity), `dv > stats.dentThreshold` (m/s). Contact-force events only record *who* we touched that step. This means steady contact (lying on the roof, scraping a wall) never dents, and both cars in a crash take damage. `world.contactPair()` then supplies the chassis-local contact points and normal. If there's no manifold, the point is inferred from the dv direction.
- **Deformation:** the chassis collider is a fixed cuboid; only the visuals deform. Vertices near the point are pushed along −normal with a smoothstep falloff. Cumulative displacement from the original shape is clamped to `maxDent`. A smooth "crumple" field (~0.5 m wavelength, a function of vertex *position*) varies the depth, so neighbouring vertices fold together instead of spiking, and duplicate seam vertices move together so meshes never tear. Per-vertex random noise looked spiky, so don't use it. Flat shading (`flatShading: true`) means no normal recompute is needed.
- **Parts:** each detachable part has HP. At 0 it is re-parented into a debris rigid body (capped pool, oldest removed first). A lost wheel has its radius and friction zeroed in the vehicle controller, since Rapier can't remove wheels.
- **Handling: arcade drift model (`Car.applyDrive` / `Car.applyGrip`).** Rapier's vehicle controller only does suspension and ground contact: its tyre friction is set to 0. We tried driving through Rapier's tyres and abandoned it: its tyres share one grip budget between engine and cornering, so throttle broke traction, and cornering scrubbed speed. The patches stacked on top (rear-grip bias, yaw assist, countersteer, damping) made it worse.
  - **Drive:** thrust (`engineForce`, N) acts along the nose at the centre of mass, scaled by grounded wheels. It never consumes grip, so throttle can't break traction, and mid-drift it powers the car through. Brakes, rolling and handbrake are decelerations in m/s².
  - **Grip:** rotates the planar velocity toward the nose at most `gripAccel / speed` rad/s, *keeping its magnitude*, minus `driftDrag × |sin slip|`. Faster means a slower-bending path, so **drifts come from cornering speed**. Sand reduces grip by `sandSlip × softness`.
  - **Yaw:** body rotation follows the bicycle-model rate `v·tan(δ)/wheelbase`, approached at `yawResponse` and capped by `maxYawRate`. The slide angle is held at `driftMaxSlip` by clamping the target to the path's turn rate.
  - **Steering lock** is `maxSteer / (1 + v / steerFadeSpeed)`. Gentle steering stays within grip at any speed, while full lock exceeds it more the faster you go.
  - **Centred wheel:** the yaw target is `-slip × selfAlign` (default 0). It must NOT include `pathRate`: nose and path would chase each other and the car kept turning on its own.
  - **Handbrake (Space):** grip × `handbrakeGrip`, recovering at `gripRecovery`/s after release. The yaw target becomes `steer × handbrakeYawRate`, independent of the speed-reduced steering lock. The slide cap is lifted.
  - **Measured from 72 km/h:** plain steering turns ~26°, a 0.2 s tap ~48° keeping speed, 0.4 s ~100°.
  - **Measured cornering:**
    - Half steer grips at 54 and 90 km/h, and drifts 12–16° at 126 km/h. Full lock drifts ~27–31° at 90–126 km/h.
    - Throttle keeps or gains speed through corners; lifting off loses ~25%.
    - At a steady speed, throttle adds no slide.
  - `Car.test.ts` "cornering" and "handbrake" lock all of this in.
- **Other assists:** speed-squared downforce, air control, auto-right when stuck upside down (keeps damage), and R for a full reset: `Game.spawnPlayer()` gives a fresh, repaired car at the current spot and heading. 0–100 km/h in 2.75 s (`engineForce` 13200), and ~335 km/h after 25 s.
- **Heightfield internal edges:** the terrain collider uses `HeightFieldFlags.FIX_INTERNAL_EDGES`. Without it, a hard landing that bottoms the suspension lets the chassis box snag a triangle edge: 260 → 12 km/h in one step plus a spin, with no damage. Keep the flag on any heightfield or trimesh cars drive on.
- **Heightfield gotcha (verified by raycast test):** Rapier heightfields are column-major, `heights[ix * n + iz]`, built with `heightfield(n-1, n-1, …)`. `TerrainData` stores row-major `iz * n + ix` and converts. Rapier splits each cell along the `(ix, iz+1)`–`(ix+1, iz)` diagonal. `sampleHeight` and the visual mesh use the same triangles, so physics, visuals and sampling agree.
- **Desert terrain:**
  - Asymmetric transverse dunes run across a wind direction (+X rotated 20°): a gentle windward slope, a steep lee face, and flat interdune troughs. They are domain-warped, with ~50–85 m spacing.
  - The arena (radius 40) has ~2 m rolls. Dunes grow to ~14 m by 120 m out, plus hills and ramps.
  - `softness` (0 firm .. 1 deep) is high on dune bodies and lee faces, and low in the troughs and the arena (~0.15).
  - `Car.surface` (a `SurfaceFn`, set by Game to use `terrain.softnessAt` for the terrain collider and 0 for everything else) drives `applySandDrag`: horizontal drag of `sandDrag × softness`. Measured: top speed 233 → 173 km/h on deep sand, and coasting bleeds much faster. Soft sand also sprays more dust.
  - Firm ground is coloured a slightly paler, dustier orange. Keep the palette saturated: an earlier beige hardpan washed out the look.
  - Parked cars hold `input.brake = 1` so they don't roll down dunes.
- **Race track (M2):**
  - World is 2048 m square (`GAME_CONFIG.terrainN` 769, ~2.7 m cells; ~0.4 s to generate). Keep tracks within ±800 m (the rim starts at ~880).
  - `TrackDef.corners` is a closed polygon in driving order; each corner is rounded with an arc of radius `r`, so radii are exact and the loop always closes. `straightLengths()` must stay positive (the test checks > 20 m). s = 0 (start/finish, checkpoint 0) is halfway along the corner 0 → 1 straight. `jump` on a corner puts a kicker on the straight leaving it. Design new layouts by rendering the polyline to an SVG in a scratch test.
  - `DUNE_LOOP` is 6.9 km, 12 checkpoints, 3 jumps, two hairpins, a chicane, S-bends and a 780 m start straight. About a third of it (`sand: [[5, 8], [13, 16], [18, 20]]`) is open sand with no road.
  - **Open sand** (`TrackDef.sand`, corner-index ranges → `path.sandiness` per sample, 30 m ramps):
    - Its profile is lightly smoothed and grade-limited to 22%, then smoothed ±30 m twice, so it rides the dunes. Vertical curvature is 0.004–0.007 1/m: bumpy, but no sags that act like walls.
    - Its softness is ≥ 0.5.
    - The ribbon fades out over it. Stakes every 20 m mark the route, and chevron boards stand outside sharp bends.
    - The Autopilot trusts 80% of its grip on sand.
  - Road profile (`Road.ts`): natural ground smoothed (±20 m, 3 box passes), grade-limited to 12%, then smoothed again (±50 m) so crests and sags stay below 0.002 1/m vertical curvature (no launching or bottoming out at 250 km/h), then 2 m kickers added. The terrain is flat to halfWidth + 2.5 m and blends to the natural dunes through banks that widen with cut depth. Road softness is 0.04.
  - **Race rules** (`Race.ts`, one tracker per racer):
    - Gates must be crossed forward and in order, within halfWidth + 10 m of the centreline (no shortcuts).
    - The timer starts at GO, and crossing checkpoint 0 completes a lap.
    - `progress` (whole laps plus distance past the last gate, capped at the next one) feeds `rankRacers` (finishers by time, then by progress).
    - Splits are compared with the best lap, which is kept in `localStorage['desert.best.<trackId>']`.
  - **Race mode** (`RaceDirector`, default):
    - Two laps (`DIRECTOR_CONFIG.laps`) against the 5 `RIVALS`. The 6-car staggered grid puts the player in slot 3 (4th).
    - Finishing shows the results panel. It updates as the AI finish, and the player's car then drives itself (cooldown autopilot).
    - **T** toggles to an endless solo time trial.
  - **Controls:** **R** = fresh repaired car 4 m past your last checkpoint (ignored after the finish). **Enter** = restart the current mode. **T** = switch mode. The tuning panel still has "Repair car here".
  - Each racer's `prev` position must be reset whenever its car is teleported or respawned (`RaceDirector.syncPrev`), or the jump can register as a gate crossing.
  - **AI rivals:**
    - Skill sets Autopilot grip (10.5–13.8 m/s²) and braking. The `DrivingStyle` multipliers then apply, and each car gets its personality's `StatModifier`s.
    - **Personalities:**
      - **Viper**, speed demon: +25% engine, late braking, less grip.
      - **Mirage**, smooth operator: +15% grip, longer look-ahead, cuts apexes toward the inside of bends.
      - **Scorpion**, bully: a heavy, tough pickup that rams any car close in front.
      - **Dune Rat**, sand runner: half the sand drag and slip, trusts its grip on sand.
      - **Rusty**, hothead: slow, with a short fuse and long grudges.
    - **Anger:** `Car` fires `onCarContact` for every car-car jolt ≥ 1.5 m/s. `RaceDirector.onCarContact` uses `wasHit` (who drove into whom). The victim's anger at the attacker grows by `impact × temper`, and an AI attacker that hit its target gets `rammed()`: revenge, so anger drops and a bully backs off for 10 s.
    - **Fighting:** at anger ≥ 0.5 (plus `aggression` for a car close in front), the rival `chase`s and rams the target until anger decays below 0.2 (`calm`/s).
    - **Winning comes first:** a rival only fights a target within 45 m that isn't more than 15 m behind it, and only while both are within 14 m of the track.
    - **Feedback:** a red marker hovers over a hunting rival, and the HUD says "<NAME> IS COMING FOR YOU" when it targets the player.
    - Each has a preferred lane. It shifts its line ±4.5 m to pass a car ahead, and lifts and brakes rather than rear-ending (unless it means to).
    - Rubber band: ±6% pace at 400 m from the player.
    - **Rescue** (fresh car at its last checkpoint):
      - after 3 s stuck, 3 s more than 30 m off the line, or 2.5 s wrecked;
      - immediately when 25 m past a gate it missed (`Race.pastNextGate`). Without this, a fight could cost a whole lap.
      - Respawns take the first free spot across the road (`respawnLanes`), so two cars rescued together never spawn inside each other.
  - **Physics tests double as track QA:**
    - `Autopilot.test.ts`: one perfect lap, ~2:50.
    - `RivalRace.test.ts`: the five personalities race a lap from the grid with grudges wired up. Measured 2:43–3:07, ≤ 1 rescue each, ≤ 38% damage. Scorpion bullies, and others fight back.
    - Both run in a few seconds. Re-run them after handling, damage or track changes. To find problems, log `s`, lateral offset, speed and health drops per step.
- **Hard landings:** damage counts only `bottomOutDamage` (10%) of a jolt that shoves the car up through its own floor (chassis-local +Y). Jump landings and bottoming out on sand used to dent and even wreck cars. Roof landings, side hits and nose-first crashes still count in full.
- **Camera / sun:** the camera sits on the −X/−Z side looking toward +X/+Z. The sun offset `(45, 70, 10)` in `Environment.ts`, mirrored by `SUN_DIR` in `Terrain.ts`, makes shadows fall toward the lower-right of the screen.
- **Units:** `Particles.emitImpact` takes strength 0..1; Game passes `dv/10`.
- **Materials are shared** across cars (cached per colour). Never dispose them; dispose geometry only. Wheel meshes use a material *array*.

## Conventions
- Keep logic testable: pure modules (`Deformer`, `TerrainData`, `CarStats`) must not import three's renderer or the DOM. Physics tests use real `@dimforge/rapier3d-compat` in node.
- Tunables live in `CarStats` (or a module-level config object), never as magic numbers buried in update loops.
- Match the surrounding style: strict TS, small classes, short doc comments on non-obvious things only.

## Testing & hooks (`.claude/settings.json`)
- **PostToolUse Edit|Write** → `.claude/hooks/after-edit.sh`. For `src/**/*.ts`, it runs `tsc` (reporting only errors *in the edited file*, so parallel agents don't block each other) plus `vitest related <file>`. Exit 2 feeds the failures back to the editing agent.
- **Stop** → `.claude/hooks/on-stop.sh` runs the full `check` and `test` and blocks the stop on failure.
- New logic gets a `*.test.ts` next to it.

## Working agreement (for Claude)
- **Delegation:** spawn Sonnet subagents (`model: "sonnet"`) for well-scoped coding tasks with a clear interface: world/FX/UI modules, tests, tuning panels, boilerplate. Give each agent disjoint files and the exact interface it must implement. Keep the architecture, physics, vehicle handling, deformation/damage and final integration and review in the main session.
- **Keep this file current:** update the Architecture and Status sections at the end of every work chunk, so a fresh session can start from here.

## Visual checks
There is no browser test in the repo. For a visual check, run `npx vite --port 5199` and drive it with a throwaway playwright-core script, kept in the session scratchpad and not added to the repo. Use `/usr/bin/chromium` with `--use-angle=swiftshader --enable-unsafe-swiftshader`. `window.game` is exposed in dev. `game.onFrame(fn)` can override the camera for close-ups, and `car.hit(localPoint, dir, strength)` dents on demand. Headless swiftshader runs at ~4 fps, so the simulation runs slow there; that's not a game bug.

## Status
**M3 is playable**:
- A two-lap race against 5 AI rivals on the Dune Loop, with positions, a minimap showing the opponents, and a results panel.
- The endless time trial is on T.
- About a third of the lap is open sand.
- Corner chevrons, chevron boards and jump stripes mark the hazards.
- Everything from M1 and M2 (damage, debris, FX, gates, stakes, parked cars, tuning panel) is unchanged.

Next ideas, in rough order:
1. Play-test on a real GPU: AI difficulty and rubber band, race length (2 laps ≈ 6 min), and whether the sand stretches are fun.
2. Combat and destruction in races: AI that rams rivals or the player, wrecked = out of the race, and damage that affects performance (engine power, steering pull).
3. Tyre tracks, camera shake on big hits.
4. A loading screen: world building takes ~1 s before the first frame.
5. Dash ability; roguelike run structure (`StatModifier` upgrades between races).
6. Bundle size: the build is ~4.9 MB because rapier-compat inlines its WASM as base64 (~1.8 MB gzipped). Acceptable for now.
