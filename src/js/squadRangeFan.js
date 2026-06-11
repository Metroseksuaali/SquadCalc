import { App } from "../app.js";
import { ImageOverlay } from "leaflet";
import SquadHeightmapHD from "./squadHeightmapHD.js";

/*
 * Range fan: terrain-aware reachability overlay for a weapon marker.
 *
 * For every cell within range, solves the firing elevation (same parabola as
 * squadFiringSolution.js) and walks the trajectory against the heightmap to
 * see whether terrain or structures block the arc on the way. The result is
 * rasterized onto a canvas (one pixel per heightmap cell) and shown as an
 * ImageOverlay:
 *
 *   green  = a valid trajectory lands here
 *   red    = in range, but the arc is masked by terrain/structures
 *   orange = inside the weapon's minimum range / elevation limit
 *   gray   = out of range
 *
 * Local experiment for the SquadHeight true-surface heightmaps (terrain +
 * buildings). Heavy enough to only run on placement/dragend, not during drag.
 */

// Down-slope targets land beyond the flat-ground max range: scan farther and
// let the solver mark the tail as out-of-range.
const SCAN_FACTOR = 1.25;
// Tolerance (m) for the surface grazing the arc, absorbs sampling noise.
const EPSILON = 0.01;

const NOT_EVALUATED = 0, REACHABLE = 1, MASKED = 2, TOO_CLOSE = 3, OUT_OF_RANGE = 4;

// RGBA per result code
const COLORS = {
    [REACHABLE]: [26, 204, 51, 90],
    [MASKED]: [217, 26, 26, 110],
    [TOO_CLOSE]: [242, 166, 26, 110],
    [OUT_OF_RANGE]: [80, 80, 80, 45],
};

export default class SquadRangeFan {

    constructor(map, weaponMarker) {
        this.map = map;
        this.marker = weaponMarker;
        this.overlay = null;
    }

    clear() {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
    }

    update() {
        this.clear();

        const hm = this.map.heightmap;
        if (!hm || !Array.isArray(hm.json) || hm.json.length === 0) return;
        const t0 = performance.now();

        const grid = hm.json;
        const N = grid.length;
        const weapon = App.activeWeapon;
        const G = App.gravity * weapon.gravityScale;
        const highArc = weapon.angleType === "high";
        const minElev = (weapon.minElevation[0] * Math.PI) / 180;
        const maxElev = (weapon.minElevation[1] * Math.PI) / 180;
        const minDistance = weapon.minDistance || 0;

        const pos = this.marker.getLatLng();
        const degreesPerMeter = this.map.gameToMapScale;
        const pixelSize = this.map.pixelSize;
        const hmScale = N / pixelSize;
        const cellMeters = (pixelSize * this.map.mapToGameScale) / N;

        // Prefer the full-res (1 m) PNG surface when staged: the 500 grid's
        // 5-8 m cells smear building walls, which decides whole masked
        // sectors. Loads async; recompute once it settles.
        let hd = this.map.heightmapHD;
        if (!hd || hd.mapURL !== this.map.activeMap.mapURL) {
            hd = this.map.heightmapHD = new SquadHeightmapHD(this.map);
        }
        if (!hd.ready && !hd.failed && !this._waitingHD) {
            this._waitingHD = true;
            hd.whenSettled(() => {
                this._waitingHD = false;
                if (this.map.hasLayer(this.marker)) this.update();
            });
        }

        // Bilinear surface sampling. The masked-area geometry is extremely
        // sensitive to the distance of near-muzzle walls, so nearest-cell
        // lookups (getHeight) are too coarse here.
        const sample500 = (lat, lng) => {
            let row = lat * -hmScale;
            let col = lng * hmScale;
            if (row < 0) row = 0; else if (row > N - 1) row = N - 1;
            if (col < 0) col = 0; else if (col > N - 1) col = N - 1;
            const r0 = Math.min(Math.floor(row), N - 2);
            const c0 = Math.min(Math.floor(col), N - 2);
            const fr = row - r0;
            const fc = col - c0;
            return grid[r0][c0] * (1 - fr) * (1 - fc)
                 + grid[r0][c0 + 1] * (1 - fr) * fc
                 + grid[r0 + 1][c0] * fr * (1 - fc)
                 + grid[r0 + 1][c0 + 1] * fr * fc;
        };
        const sample = hd.ready ? (lat, lng) => hd.sample(lat, lng) : sample500;

        // Muzzle ground. On the coarse grid: minimum of the four surrounding
        // cells, not bilinear — a building wall smears into the adjacent
        // street cell and bilinear would put a weapon standing next to a wall
        // meters up that artificial slope. At 1 m resolution bilinear is fine.
        let ground;
        if (hd.ready) {
            ground = hd.sample(pos.lat, pos.lng);
        } else {
            const mr = Math.min(Math.max(pos.lat * -hmScale, 0), N - 1);
            const mc = Math.min(Math.max(pos.lng * hmScale, 0), N - 1);
            const mr0 = Math.min(Math.floor(mr), N - 2);
            const mc0 = Math.min(Math.floor(mc), N - 2);
            ground = Math.min(grid[mr0][mc0], grid[mr0][mc0 + 1],
                              grid[mr0 + 1][mc0], grid[mr0 + 1][mc0 + 1]);
        }

        const padding = parseFloat(this.marker.heightPadding) || 0;
        const muzzle = ground + padding + weapon.heightOffset;

        const maxRange = weapon.getMaxDistance() * SCAN_FACTOR;
        const step = cellMeters;
        const n = Math.ceil(maxRange / step);
        const nAz = Math.ceil((2 * Math.PI * maxRange) / step);

        // Walls right next to the muzzle decide whole masked sectors, and the
        // first regular sample is already a full cell out — probe the first
        // two cells at quarter-cell spacing as additional obstacles.
        const nearRs = [];
        for (let r = step / 4; r < 2 * step; r += step / 4) nearRs.push(r);

        // best (lowest) result code per heightmap cell, 0 = untouched
        const codes = new Uint8Array(N * N);
        const h = new Float64Array(n + 1);     // surface height relative to muzzle
        const nearH = new Float64Array(nearRs.length);
        const cellIdx = new Int32Array(n + 1); // raster index per sample

        for (let a = 0; a < nAz; a++) {
            const ang = (2 * Math.PI * a) / nAz;
            const dLat = Math.cos(ang) * degreesPerMeter;
            const dLng = Math.sin(ang) * degreesPerMeter;

            // Sample the surface along the ray until it leaves the map.
            let m = 0;
            for (let i = 1; i <= n; i++) {
                const lat = pos.lat + i * step * dLat;
                const lng = pos.lng + i * step * dLng;
                if (lat > 0 || lat < -pixelSize || lng < 0 || lng > pixelSize) break;
                let row = Math.round(lat * -hmScale);
                let col = Math.round(lng * hmScale);
                if (row > N - 1) row = N - 1;
                if (col > N - 1) col = N - 1;
                h[i] = sample(lat, lng) - muzzle;
                cellIdx[i] = row * N + col;
                m = i;
            }
            for (let q = 0; q < nearRs.length; q++) {
                const lat = pos.lat + nearRs[q] * dLat;
                const lng = pos.lng + nearRs[q] * dLng;
                nearH[q] = (lat > 0 || lat < -pixelSize || lng < 0 || lng > pixelSize)
                    ? -Infinity : sample(lat, lng) - muzzle;
            }

            // Classify every cell along this ray as a potential impact point.
            for (let i = 1; i <= m; i++) {
                const R = i * step;          // horizontal distance to this cell
                let code;
                if (R < minDistance) {
                    code = TOO_CLOSE;
                } else {
                    // Firing solution: same closed-form elevation as
                    // squadFiringSolution.js getElevation(). The discriminant
                    // going negative means the target is simply out of reach;
                    // the +/- root picks the high or low arc. h[i] is the
                    // target's height above the muzzle.
                    const v = weapon.getVelocity(R);
                    const v2 = v * v;
                    const disc = v2 * v2 - G * (G * R * R + 2 * h[i] * v2);
                    if (disc < 0) {
                        code = OUT_OF_RANGE;
                    } else {
                        const root = Math.sqrt(disc);
                        const elev = Math.atan2(v2 + (highArc ? root : -root), G * R);
                        if (elev < minElev || elev > maxElev) {
                            // Solution exists but the barrel can't be aimed there.
                            code = OUT_OF_RANGE;
                        } else {
                            // The projectile flies the parabola
                            //   z(r) = r*tan(elev) - k*r^2,  k = G / (2 (v cos)^2)
                            // (height above the muzzle at horizontal distance r).
                            // The shot is masked if the surface reaches that arc
                            // anywhere before the target.
                            const tan = Math.tan(elev);
                            const cosE = Math.cos(elev);
                            const k = G / (2 * v2 * cosE * cosE);
                            code = REACHABLE;
                            // Near-muzzle obstacles first (the quarter-cell
                            // probes): a wall right next to the tube blocks the
                            // whole sector and is missed by the full-cell samples.
                            for (let q = 0; q < nearRs.length; q++) {
                                const rq = nearRs[q];
                                if (rq < R && nearH[q] >= rq * tan - k * rq * rq - EPSILON) {
                                    code = MASKED;
                                    break;
                                }
                            }
                            // Then the regular samples between muzzle and target.
                            if (code === REACHABLE) {
                                for (let j = 1; j < i; j++) {
                                    const rj = j * step;
                                    if (h[j] >= rj * tan - k * rj * rj - EPSILON) {
                                        code = MASKED;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                // Several rays cross one cell; keep the most permissive verdict
                // (codes are ordered REACHABLE < MASKED < ... so lower wins).
                const idx = cellIdx[i];
                if (codes[idx] === NOT_EVALUATED || code < codes[idx]) codes[idx] = code;
            }
        }

        // Rasterize codes to a canvas, one pixel per heightmap cell.
        const canvas = document.createElement("canvas");
        canvas.width = N;
        canvas.height = N;
        const ctx = canvas.getContext("2d");
        const img = ctx.createImageData(N, N);
        const px = img.data;
        for (let i = 0; i < codes.length; i++) {
            const color = COLORS[codes[i]];
            if (!color) continue;
            const o = i * 4;
            px[o] = color[0];
            px[o + 1] = color[1];
            px[o + 2] = color[2];
            px[o + 3] = color[3];
        }
        ctx.putImageData(img, 0, 0);

        this.overlay = new ImageOverlay(canvas.toDataURL(), this.map.imageBounds, {
            interactive: false,
        }).addTo(this.map);

        console.debug(`[rangefan] ${weapon.name} ${nAz} rays in ${(performance.now() - t0).toFixed(0)} ms`);
    }
}
