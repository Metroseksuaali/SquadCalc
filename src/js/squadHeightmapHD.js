/*
 * Full-resolution (1 m) surface heightmap, decoded from SquadHeight's 16-bit
 * grayscale PNG export. Heights in meters = pixel value * png_meters_per_unit
 * (from hd_meta.json), min-normalized like the 500x500 JSON grid.
 *
 * Loaded lazily and entirely optional: when the files are missing (404) the
 * consumer keeps using the coarse 500 grid. Decoding is hand-rolled
 * (DecompressionStream + PNG unfiltering) to avoid a new dependency.
 *
 * DATA SOURCE: the per-map files this fetches —
 *   ${API_URL}<mapURL>heightmap_hd.png   (16-bit grayscale, full-res surface)
 *   ${API_URL}<mapURL>hd_meta.json       (georeference incl. png_meters_per_unit)
 * are NOT bundled with SquadCalc. Get them from the SquadHeight project:
 *   https://github.com/Metroseksuaali/SquadHeight  (Releases ->
 *   heightmap_images_16bit_png.zip for the PNGs; each map's meta.json ships
 *   alongside its export). Host them under your map data path, or stage them
 *   locally with squadcalc-test/stage_heightmaps.py (copies heightmap.png ->
 *   heightmap_hd.png and meta.json -> hd_meta.json per map). Without them the
 *   range fan silently falls back to the bundled 500x500 heightmap.
 */

/**
 * Decode a non-interlaced 16-bit grayscale PNG into a Uint16Array.
 * @param {ArrayBuffer} buf - raw PNG bytes
 * @returns {Promise<{width: number, height: number, data: Uint16Array}>}
 */
async function decodePng16(buf) {
    const dv = new DataView(buf);
    let off = 8; // skip PNG signature
    let width = 0, height = 0;
    const idat = [];

    while (off + 12 <= buf.byteLength) {
        const len = dv.getUint32(off);
        const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5),
                                         dv.getUint8(off + 6), dv.getUint8(off + 7));
        if (type === "IHDR") {
            width = dv.getUint32(off + 8);
            height = dv.getUint32(off + 12);
            const bitDepth = dv.getUint8(off + 16);
            const colorType = dv.getUint8(off + 17);
            const interlace = dv.getUint8(off + 20);
            if (bitDepth !== 16 || colorType !== 0 || interlace !== 0) {
                throw new Error(`expected non-interlaced 16-bit grayscale PNG, got depth ${bitDepth} color ${colorType} interlace ${interlace}`);
            }
        } else if (type === "IDAT") {
            idat.push(new Uint8Array(buf, off + 8, len).slice());
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (!width || idat.length === 0) throw new Error("malformed PNG");

    // IDAT is one zlib stream split across chunks.
    const ds = new DecompressionStream("deflate");
    const raw = new Uint8Array(
        await new Response(new Blob(idat).stream().pipeThrough(ds)).arrayBuffer());

    // Undo per-scanline filters (bpp = 2 bytes, grayscale 16-bit).
    const bpp = 2;
    const stride = width * bpp;
    const out = new Uint16Array(width * height);
    let pos = 0;
    let prev = new Uint8Array(stride);
    let cur = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        cur.set(raw.subarray(pos, pos + stride));
        pos += stride;
        if (filter === 1) {
            for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255;
        } else if (filter === 2) {
            for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255;
        } else if (filter === 3) {
            for (let i = 0; i < stride; i++) {
                const a = i >= bpp ? cur[i - bpp] : 0;
                cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 255;
            }
        } else if (filter === 4) {
            for (let i = 0; i < stride; i++) {
                const a = i >= bpp ? cur[i - bpp] : 0;
                const b = prev[i];
                const c = i >= bpp ? prev[i - bpp] : 0;
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
            }
        } else if (filter !== 0) {
            throw new Error(`unknown PNG filter ${filter}`);
        }
        const rowBase = y * width;
        for (let x = 0; x < width; x++) {
            out[rowBase + x] = (cur[x * bpp] << 8) | cur[x * bpp + 1]; // big-endian
        }
        const swap = prev; prev = cur; cur = swap;
    }
    return { width, height, data: out };
}


export default class SquadHeightmapHD {

    /**
     * @param {squadMinimap} map - kicks off the async load immediately
     */
    constructor(map) {
        this.map = map;
        this.mapURL = map.activeMap.mapURL;
        this.ready = false;
        this.failed = false;
        this._onReady = [];
        this._load();
    }

    /** Register a callback fired once when loading settles (ready or failed). */
    whenSettled(cb) {
        if (this.ready || this.failed) cb();
        else this._onReady.push(cb);
    }

    async _load() {
        const base = `${process.env.API_URL}${this.mapURL}`;
        try {
            const t0 = performance.now();
            const [metaResp, pngResp] = await Promise.all([
                fetch(`${base}hd_meta.json`),
                fetch(`${base}heightmap_hd.png`),
            ]);
            if (!metaResp.ok || !pngResp.ok) throw new Error("no HD heightmap staged");
            const meta = await metaResp.json();
            const png = await decodePng16(await pngResp.arrayBuffer());
            this.metersPerUnit = meta.png_meters_per_unit;
            this.width = png.width;
            this.height = png.height;
            this.data = png.data;
            this.ready = true;
            console.debug(`[heightmapHD] ${this.mapURL} ${png.width}x${png.height} in ${(performance.now() - t0).toFixed(0)} ms`);
        } catch (e) {
            this.failed = true;
            console.debug(`[heightmapHD] falling back to 500 grid: ${e.message}`);
        }
        this._onReady.forEach((cb) => cb());
        this._onReady = [];
    }

    /**
     * Bilinear surface height (meters) at a map latlng. Same square mapping
     * as the 500 grid: the image spans the full [0,pixelSize] map square.
     */
    sample(lat, lng) {
        const px = this.map.pixelSize;
        let row = (-lat / px) * (this.height - 1);
        let col = (lng / px) * (this.width - 1);
        if (row < 0) row = 0; else if (row > this.height - 1) row = this.height - 1;
        if (col < 0) col = 0; else if (col > this.width - 1) col = this.width - 1;
        const r0 = Math.min(Math.floor(row), this.height - 2);
        const c0 = Math.min(Math.floor(col), this.width - 2);
        const fr = row - r0;
        const fc = col - c0;
        const d = this.data, w = this.width, o = r0 * w + c0;
        return (d[o] * (1 - fr) * (1 - fc)
              + d[o + 1] * (1 - fr) * fc
              + d[o + w] * fr * (1 - fc)
              + d[o + w + 1] * fr * fc) * this.metersPerUnit;
    }
}
