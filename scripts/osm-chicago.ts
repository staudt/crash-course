/**
 * Builds src/city/chicago.json (the Chicago Loop level) from OpenStreetMap.
 *
 *   npm run osm:chicago             convert the cached Overpass download (fetching it first if missing)
 *   npm run osm:chicago -- --fetch  download again, then convert
 *
 * The raw download is cached in scripts/.osm-cache/ (git-ignored); only the converted file is committed.
 * Data © OpenStreetMap contributors, ODbL: the output is an ODbL derivative database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import { CHICAGO_ROUTE, convertChicago, type OverpassResponse } from '../src/city/osm.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts/.osm-cache/chicago.json');
const TRACK_OUT = join(ROOT, 'src/city/chicago-track.json');
const CITY_OUT = join(ROOT, 'src/city/chicago.json');

/** Pinned so a re-download gives the same data (mirrors without attic support fall back to current data). */
const DATE = '2026-10-01T00:00:00Z';
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'desert-game-osm-script/0.1 (offline track builder)';

function query(pinned: boolean): string {
  const [s, w, n, e] = CHICAGO_ROUTE.bbox;
  const bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:240]${pinned ? `[date:"${DATE}"]` : ''};
(
  way[highway](${bbox});
  way[building](${bbox});
  way["building:part"](${bbox});
  relation[building](${bbox});
  relation["building:part"](${bbox});
  way[railway](${bbox});
)->.main;
.main out body geom;
(
  way[natural=water](${bbox});
  relation[natural=water](${bbox});
  way[waterway=riverbank](${bbox});
  relation[waterway=riverbank](${bbox});
)->.water;
.water out body geom;`;
}

async function download(): Promise<string> {
  let wait = 15;
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length]!;
    // Every mirror once with the pinned date, then also without (some mirrors have no attic data).
    const pinned = attempt < MIRRORS.length * 2 || attempt % 2 === 0;
    try {
      console.log(`[osm] ${url} (${pinned ? `as of ${DATE}` : 'current data'})`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query(pinned) }),
        signal: AbortSignal.timeout(300_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const parsed = JSON.parse(text) as OverpassResponse & { remark?: string };
        if (parsed.remark && /error/i.test(parsed.remark)) throw new Error(parsed.remark);
        // Remember the pinned date in the cache (the response only says when the server's data was last updated).
        if (parsed.elements.length > 0) return pinned ? JSON.stringify({ ...parsed, date: DATE }) : text;
        throw new Error('empty response');
      }
      throw new Error(`HTTP ${res.status}: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`);
    } catch (err) {
      console.log(`[osm]   failed: ${(err as Error).message}`);
    }
    console.log(`[osm]   retrying in ${wait} s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    wait = Math.min(240, wait * 2);
  }
  throw new Error('Overpass: every attempt failed');
}

if (process.argv.includes('--fetch') || !existsSync(CACHE)) {
  const raw = await download();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, raw);
  console.log(`[osm] cached ${(raw.length / 1e6).toFixed(1)} MB in ${CACHE}`);
}
if (process.argv.includes('--fetch-only')) process.exit(0);

const { track, city } = convertChicago(JSON.parse(readFileSync(CACHE, 'utf8')) as OverpassResponse, polygonClipping);
writeFileSync(TRACK_OUT, JSON.stringify(track, null, 2) + '\n');
const json = JSON.stringify(city);
writeFileSync(CITY_OUT, json + '\n');
console.log(`[osm] track: ${JSON.stringify(track)}`);
console.log(`[osm] wrote ${CITY_OUT}: ${(json.length / 1e3).toFixed(0)} kB, ${city.buildings.length} buildings, ${city.mouths.length} side-street mouths, ${city.decks.length} decks, ${city.cut.length} cut areas`);
