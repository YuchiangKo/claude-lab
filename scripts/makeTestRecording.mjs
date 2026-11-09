/*
產生模擬的直播錄製檔，用來在沒有比賽的時候測試 liveRelay.mjs 與網站的直播模式。

把 OpenF1 上一場已結束正賽的資料，轉成和 F1 官方即時資料流相同格式的訊息（recordings/*.jsonl），
再用 node scripts/liveRelay.mjs --replay 檔案 --speed 10 重播。

注意：這是依照官方資料流的格式「模擬」出來的，小段通過的時間是把區段時間平均切分估計的；
真正的直播細節仍要用實際比賽（或練習賽）錄下的檔案驗證。

執行：node scripts/makeTestRecording.mjs [session_key]（預設為最近一場正賽）
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiBase = 'https://api.openf1.org/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${apiBase}/${path}`);
    if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
    if (res.status === 401) throw new Error('OpenF1 目前鎖住免費存取（可能有賽事正在進行）');
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    await sleep(400);
    return res.json();
  }
  throw new Error('請求過於頻繁');
}
const fmtLap = (sec) => { const m = Math.floor(sec / 60); return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`; };

const sessions = await getJson('sessions?session_name=Race&year=2026');
const key = Number(process.argv[2]) || sessions.filter((s) => Date.parse(s.date_end) < Date.now()).sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))[0].session_key;
const sess = (await getJson(`sessions?session_key=${key}`))[0];
const meeting = (await getJson(`meetings?meeting_key=${sess.meeting_key}`))[0] || {};
console.log(`產生 ${sess.location} ${sess.year} 正賽的模擬錄製檔…`);
const [drivers, laps, positions, intervals, pits, stints, rcs, radios, weather] = [
  await getJson(`drivers?session_key=${key}`), await getJson(`laps?session_key=${key}`), await getJson(`position?session_key=${key}`),
  await getJson(`intervals?session_key=${key}`), await getJson(`pit?session_key=${key}`), await getJson(`stints?session_key=${key}`),
  await getJson(`race_control?session_key=${key}`), await getJson(`team_radio?session_key=${key}`), await getJson(`weather?session_key=${key}`),
];

const events = []; // [ts, topic, data]
const at = (ts, topic, data) => { if (Number.isFinite(ts)) events.push([ts, topic, data]); };
const line = (n, data) => ({ Lines: { [n]: data } });

// 錄音檔路徑：官方資料流只給「TeamRadio/xxx.mp3」，前面要接上賽事路徑
const anyRadio = radios.find((r) => r.recording_url);
const sessionPath = anyRadio ? decodeURI(anyRadio.recording_url).replace(/^https:\/\/livetiming\.formula1\.com\/static\//, '').replace(/TeamRadio\/.*$/, '') : '';
const firstLap = Math.min(...laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => Date.parse(l.date_start)));
const t0 = firstLap - 3 * 60000;
const segCounts = [1, 2, 3].map((k) => Math.max(...laps.map((l) => (l[`segments_sector_${k}`] || []).length)));

// 一開始的完整狀態（相當於剛連上資料流時收到的內容）
const initLines = {}; const initApp = {}; const driverList = {};
drivers.forEach((d, i) => {
  const n = String(d.driver_number);
  driverList[n] = { RacingNumber: n, Tla: d.name_acronym, FullName: d.full_name, LastName: d.last_name, FirstName: d.first_name, TeamName: d.team_name, TeamColour: d.team_colour, Line: i + 1 };
  initLines[n] = { Line: i + 1, Position: String(i + 1), RacingNumber: n, GapToLeader: '', IntervalToPositionAhead: { Value: '', Catching: false }, Retired: false, InPit: false, PitOut: false, Stopped: false, NumberOfLaps: 0, NumberOfPitStops: 0,
    Sectors: segCounts.map((c) => ({ Value: '', PreviousValue: '', OverallFastest: false, PersonalFastest: false, Segments: Array.from({ length: c }, () => ({ Status: 0 })) })),
    BestLapTime: { Value: '' }, LastLapTime: { Value: '', OverallFastest: false, PersonalFastest: false } };
  initApp[n] = { RacingNumber: n, Stints: [] };
});
const initial = {
  SessionInfo: { Meeting: { Key: sess.meeting_key, Name: meeting.meeting_name || `${sess.location} Grand Prix`, OfficialName: meeting.meeting_official_name || '', Country: { Name: sess.country_name }, Circuit: { Key: sess.circuit_key, ShortName: sess.circuit_short_name } }, Type: 'Race', Name: 'Race', Path: sessionPath },
  SessionStatus: { Status: 'Inactive' }, TrackStatus: { Status: '1', Message: 'AllClear' },
  LapCount: { CurrentLap: 1, TotalLaps: Math.max(...laps.map((l) => l.lap_number)) },
  ExtrapolatedClock: { Utc: new Date(t0).toISOString(), Remaining: '02:00:00', Extrapolating: false },
  DriverList: driverList, TimingData: { Lines: initLines }, TimingAppData: { Lines: initApp },
  WeatherData: {}, RaceControlMessages: { Messages: [] }, TeamRadio: { Captures: [] },
};
const out = Object.entries(initial).map(([topic, data]) => [t0, topic, data, 1]);

at(firstLap - 30000, 'SessionStatus', { Status: 'Started' });
at(firstLap - 30000, 'ExtrapolatedClock', { Utc: new Date(firstLap - 30000).toISOString(), Remaining: '02:00:00', Extrapolating: true });

// 每圈：區段與小段的通過時間（區段時間平均切分）、單圈時間、最快紀錄
const overall = { sec: [Infinity, Infinity, Infinity], lap: Infinity };
const personal = {};
const lapsSorted = laps.filter((l) => l.date_start).sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
// 先算出每個事件發生的時間，再依時間順序判斷是不是最快
const lapEvents = [];
lapsSorted.forEach((l) => {
  const n = String(l.driver_number); const ts = Date.parse(l.date_start);
  const secs = [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3];
  lapEvents.push({ ts, kind: 'start', n, l });
  let acc = 0;
  secs.forEach((dur, k) => {
    if (!dur) { acc = null; return; }
    if (acc == null) return;
    const segs = l[`segments_sector_${k + 1}`] || [];
    segs.forEach((code, j) => lapEvents.push({ ts: ts + (acc + dur * (j + 1) / segs.length) * 1000 - 1, kind: 'seg', n, k, j, code: code || 2048 }));
    acc += dur;
    lapEvents.push({ ts: ts + acc * 1000, kind: 'sector', n, k, dur });
  });
  if (l.lap_duration) lapEvents.push({ ts: ts + l.lap_duration * 1000 + 1, kind: 'lap', n, l });
});
lapEvents.sort((a, b) => a.ts - b.ts);
const prevSec = {};
let leaderLap = 1;
lapEvents.forEach((e) => {
  const p = personal[e.n] = personal[e.n] || { sec: [Infinity, Infinity, Infinity], lap: Infinity };
  if (e.kind === 'start') {
    // 新的一圈：清空區段，保留上一圈的值在 PreviousValue
    const ps = prevSec[e.n] || ['', '', ''];
    at(e.ts, 'TimingData', line(e.n, { Sectors: Object.fromEntries(segCounts.map((c, k) => [k, { Value: '', PreviousValue: ps[k], OverallFastest: false, PersonalFastest: false, Segments: Object.fromEntries(Array.from({ length: c }, (_, j) => [j, { Status: 0 }])) }])) }));
    if (e.l.lap_number > leaderLap) { leaderLap = e.l.lap_number; at(e.ts, 'LapCount', { CurrentLap: leaderLap }); }
  } else if (e.kind === 'seg') {
    at(e.ts, 'TimingData', line(e.n, { Sectors: { [e.k]: { Segments: { [e.j]: { Status: e.code } } } } }));
  } else if (e.kind === 'sector') {
    const ob = e.dur < overall.sec[e.k]; const pb = e.dur < p.sec[e.k];
    if (ob) overall.sec[e.k] = e.dur; if (pb) p.sec[e.k] = e.dur;
    (prevSec[e.n] = prevSec[e.n] || ['', '', ''])[e.k] = e.dur.toFixed(3);
    at(e.ts, 'TimingData', line(e.n, { Sectors: { [e.k]: { Value: e.dur.toFixed(3), OverallFastest: ob, PersonalFastest: pb } } }));
  } else if (e.kind === 'lap') {
    const v = e.l.lap_duration; const ob = v < overall.lap && !e.l.is_pit_out_lap; const pb = v < p.lap;
    if (ob) overall.lap = v; if (pb) p.lap = v;
    const d = { NumberOfLaps: e.l.lap_number, LastLapTime: { Value: fmtLap(v), OverallFastest: ob, PersonalFastest: pb } };
    if (pb) d.BestLapTime = { Value: fmtLap(v), Lap: e.l.lap_number };
    at(e.ts, 'TimingData', line(e.n, d));
  }
});

positions.forEach((p) => at(Date.parse(p.date), 'TimingData', line(String(p.driver_number), { Position: String(p.position) })));
const fmtGap = (v) => v == null ? '' : typeof v === 'number' ? `+${v.toFixed(3)}` : String(v);
intervals.forEach((r) => at(Date.parse(r.date), 'TimingData', line(String(r.driver_number), { GapToLeader: fmtGap(r.gap_to_leader), IntervalToPositionAhead: { Value: fmtGap(r.interval) } })));
// 進站：OpenF1 的時間接近出站時刻
const stops = {};
pits.filter((p) => p.date).forEach((p) => {
  const n = String(p.driver_number); const out = Date.parse(p.date); const lane = (p.lane_duration || p.pit_duration || 22) * 1000;
  stops[n] = (stops[n] || 0) + 1;
  at(out - lane, 'TimingData', line(n, { InPit: true, NumberOfPitStops: stops[n] }));
  at(out, 'TimingData', line(n, { InPit: false, PitOut: true }));
  at(out + 15000, 'TimingData', line(n, { PitOut: false }));
});
// 輪胎：換胎時新增一段，之後每圈更新胎齡
const lapStartTs = {};
lapsSorted.forEach((l) => { lapStartTs[`${l.driver_number}-${l.lap_number}`] = Date.parse(l.date_start); });
const stintIdx = {};
stints.sort((a, b) => a.stint_number - b.stint_number).forEach((st) => {
  const n = String(st.driver_number); const idx = stintIdx[n] = (stintIdx[n] ?? -1) + 1;
  const startTs = lapStartTs[`${n}-${st.lap_start}`] ?? firstLap;
  at(startTs, 'TimingAppData', line(n, { Stints: { [idx]: { Compound: st.compound, New: st.tyre_age_at_start ? 'false' : 'true', TotalLaps: st.tyre_age_at_start, StartLaps: st.tyre_age_at_start } } }));
  for (let lap = st.lap_start; lap <= (st.lap_end || st.lap_start); lap++) {
    const ts = lapStartTs[`${n}-${lap + 1}`];
    if (ts) at(ts, 'TimingAppData', line(n, { Stints: { [idx]: { TotalLaps: st.tyre_age_at_start + lap - st.lap_start + 1 } } }));
  }
});
// 賽事管制訊息與賽道狀態
const trackFrom = (m) => /VIRTUAL SAFETY CAR DEPLOYED/.test(m) ? ['6', 'VSCDeployed'] : /VIRTUAL SAFETY CAR ENDING/.test(m) ? ['7', 'VSCEnding'] : /SAFETY CAR DEPLOYED/.test(m) ? ['4', 'SCDeployed'] : /RED FLAG/.test(m) ? ['5', 'Red'] : /TRACK CLEAR|GREEN LIGHT|SAFETY CAR IN THIS LAP/.test(m) ? ['1', 'AllClear'] : null;
rcs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).forEach((r, i) => {
  const ts = Date.parse(r.date);
  at(ts, 'RaceControlMessages', { Messages: { [i]: { Utc: r.date.slice(0, 19), Lap: r.lap_number, Category: r.category, Flag: r.flag, Scope: r.scope, Message: r.message } } });
  const t = trackFrom(r.message || ''); if (t) at(ts, 'TrackStatus', { Status: t[0], Message: t[1] });
  if (r.flag === 'CHEQUERED') { at(ts + 1000, 'SessionStatus', { Status: 'Finished' }); at(ts + 1000, 'ExtrapolatedClock', { Utc: new Date(ts).toISOString(), Remaining: '00:00:00', Extrapolating: false }); }
});
radios.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).forEach((r, i) => {
  const path = decodeURI(r.recording_url).replace(/^.*\/(TeamRadio\/.*)$/, '$1');
  at(Date.parse(r.date), 'TeamRadio', { Captures: { [i]: { Utc: r.date, RacingNumber: String(r.driver_number), Path: path } } });
});
weather.forEach((w) => at(Date.parse(w.date), 'WeatherData', { AirTemp: String(w.air_temperature), TrackTemp: String(w.track_temperature), Humidity: String(w.humidity), Rainfall: String(w.rainfall), WindSpeed: String(w.wind_speed), WindDirection: String(w.wind_direction), Pressure: String(w.pressure) }));

events.sort((a, b) => a[0] - b[0]);
mkdirSync(join(root, 'recordings'), { recursive: true });
const file = join(root, 'recordings', `test-${sess.location.replace(/\W+/g, '')}-${sess.year}.jsonl`);
writeFileSync(file, [...out, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`完成：${file}（${events.length} 筆訊息）`);
