/*
賽道輪廓資料：比賽即時模式用來畫賽道與推算車輛位置。
比賽進行中 OpenF1 會鎖住免費存取，所以要事先產生好存在 data/trackOutlines.json。

做法：每條賽道取最近一場正賽裡最快的一圈，用那一圈的車輛座標畫出賽道，
並依時間平均取 N 個點（第 i 個點＝跑了 i/N 圈時的位置），同時記下 S1、S2 結束時是第幾成圈。

執行：node scripts/buildTrackOutlines.mjs
已存在的賽道會略過；加上 --force 全部重做。
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiBase = 'https://api.openf1.org/v1';
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'trackOutlines.json');
const pointCount = 400;
const force = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${apiBase}/${path}`, { headers: { 'User-Agent': 'lights-out-f1-fan-site' } });
    if (res.status === 404) return [];
    if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
    if (res.status === 401) throw new Error('OpenF1 目前鎖住免費存取（可能有賽事正在進行），請等賽事結束再執行');
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    await sleep(400);
    return res.json();
  }
  throw new Error(`請求過於頻繁：${path}`);
}

// 依時間在座標之間內插
function sampleAt(pts, t) {
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  const k = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  return [Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

async function buildOutline(session) {
  const laps = await getJson(`laps?session_key=${session.session_key}`);
  const ref = laps.filter((l) => l.lap_number >= 3 && l.lap_duration && !l.is_pit_out_lap && l.duration_sector_1 && l.duration_sector_2 && l.duration_sector_3 && l.date_start)
    .sort((a, b) => a.lap_duration - b.lap_duration)[0];
  if (!ref) return null;
  const start = Date.parse(ref.date_start); const lapMs = ref.lap_duration * 1000;
  const raw = await getJson(`location?session_key=${session.session_key}&driver_number=${ref.driver_number}&date>${new Date(start - 3000).toISOString()}&date<${new Date(start + lapMs + 3000).toISOString()}`);
  const pts = raw.filter((p) => p.x || p.y).map((p) => [Date.parse(p.date), p.x, p.y]).sort((a, b) => a[0] - b[0]);
  if (pts.length < 100) return null;
  const outline = Array.from({ length: pointCount }, (_, i) => sampleAt(pts, start + (i / pointCount) * lapMs));
  return {
    name: session.circuit_short_name,
    source: `${session.year} ${session.location} ${session.session_name}`,
    lapSec: ref.lap_duration,
    // S1、S2 結束時是第幾成圈（以時間計）
    sectors: [ref.duration_sector_1 / ref.lap_duration, (ref.duration_sector_1 + ref.duration_sector_2) / ref.lap_duration].map((v) => Math.round(v * 10000) / 10000),
    pts: outline,
  };
}

const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
const sessions = [...await getJson('sessions?year=2025&session_name=Race'), ...await getJson('sessions?year=2026&session_name=Race')]
  .filter((s) => Date.parse(s.date_end) < Date.now())
  .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
// 每條賽道由新到舊嘗試，取第一場有資料的
const byCircuit = new Map();
sessions.forEach((s) => { if (!byCircuit.has(s.circuit_key)) byCircuit.set(s.circuit_key, []); byCircuit.get(s.circuit_key).push(s); });
for (const [key, list] of byCircuit) {
  if (existing[key] && !force) { console.log(`略過 ${existing[key].name}（已存在）`); continue; }
  for (const s of list) {
    try {
      const o = await buildOutline(s);
      if (o) { existing[key] = o; console.log(`完成 ${o.name}：${o.source}，參考圈 ${o.lapSec}s`); break; }
      console.log(`${s.circuit_short_name} ${s.year} 沒有足夠資料，改用更早的比賽`);
    } catch (e) { console.error(`${s.circuit_short_name} ${s.year} 失敗：${e.message}`); if (/鎖住/.test(e.message)) process.exit(1); }
  }
}
writeFileSync(outPath, JSON.stringify(existing) + '\n');
console.log(`已寫入 ${Object.keys(existing).length} 條賽道 → data/trackOutlines.json`);
