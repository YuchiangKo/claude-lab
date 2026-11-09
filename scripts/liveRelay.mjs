/*
比賽即時轉送程式：比賽時在 Mac 上執行，讓網站「賽事回顧」分頁即時更新。

它會：
  1. 連上 F1 官方即時資料流（livetiming.formula1.com，不需登入的頻道）
  2. 用計時資料的小段（mini sector）推算每台車在賽道上的位置（車輛座標需要 F1 TV 帳號，所以用推算的）
  3. 每出現一段無線電就下載並用 Whisper 轉成文字（scripts/radioWorker.py）
  4. 開一個本機伺服器，以 Server-Sent Events 推送給網頁；可選擇開 Cloudflare 通道讓所有人都連得到
  5. 把收到的原始資料錄成 recordings/*.jsonl，之後可以重播測試

用法（在專案資料夾執行）：
  比賽日：  node scripts/liveRelay.mjs --tunnel --publish
  只在本機：node scripts/liveRelay.mjs                   （網頁開 http://localhost:8000/?relay=http://localhost:8787#live）
  重播測試：node scripts/liveRelay.mjs --replay recordings/檔名.jsonl --speed 10 --skip 20
選項：
  --port 8787       本機伺服器埠號
  --tunnel          開 Cloudflare 快速通道（需要 cloudflared）
  --publish         把通道網址寫進 data/liveEndpoint.json 並推上 GitHub，網站就會自動切換成直播；結束時（Ctrl+C）會自動撤下
  --no-radio        不轉錄無線電
  --no-record       不錄製原始資料
  --replay 檔案     重播錄下的資料，不連官方資料流
  --speed N         重播速度（預設 1）
  --skip N          重播時跳過開頭 N 分鐘
*/
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const port = Number(opt('--port', 8787));
const replayFile = opt('--replay', null);
const speed = Number(opt('--speed', 1));
const skipMin = Number(opt('--skip', 0));
const useRadio = !flag('--no-radio');
const useRecord = !flag('--no-record') && !replayFile;

const feedBase = 'https://livetiming.formula1.com';
const topics = ['Heartbeat', 'SessionInfo', 'SessionStatus', 'TrackStatus', 'LapCount', 'ExtrapolatedClock', 'DriverList',
  'TimingData', 'TimingAppData', 'TimingStats', 'WeatherData', 'RaceControlMessages', 'TeamRadio'];
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-TW', { hour12: false }), ...a);

/* ================= 時間：直播用真實時間，重播用資料裡的時間 ================= */
let clock = { replay: false, base: 0, realBase: 0 };
const now = () => clock.replay ? clock.base + (Date.now() - clock.realBase) * speed : Date.now();

/* ================= 資料流狀態 ================= */
const state = {};
// 官方資料流的陣列在更新時會以 {"索引": 值} 的物件送來，這裡統一轉回陣列
const vals = (x) => !x ? [] : Array.isArray(x) ? x : Object.keys(x).sort((a, b) => a - b).map((k) => x[k]);
function merge(target, delta) {
  for (const [k, v] of Object.entries(delta)) {
    if (k === '_deleted') { (v || []).forEach((d) => { delete target[d]; }); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
      merge(target[k], v);
    } else target[k] = v;
  }
}

/* ================= 賽道輪廓與車輛位置推算 ================= */
const outlines = JSON.parse(readFileSync(join(root, 'data', 'trackOutlines.json'), 'utf8'));
let outline = null;     // 目前賽道
const est = {};         // 每台車的推算狀態
const samples = {};     // 每個小段實際落在一圈的第幾成（自動校正用）
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function segLayout() {
  // 各區段有幾個小段：取任一台車的資料
  const line = Object.values(state.TimingData?.Lines || {})[0];
  const counts = line ? vals(line.Sectors).map((s) => vals(s.Segments).length) : [];
  return counts.length === 3 && counts.every((c) => c > 0) ? counts : null;
}
// 第 g 個小段結束時是第幾成圈：資料夠就用實測中位數，不夠就把每個區段平均切分
function segEnd(g) {
  const counts = segLayout();
  if (!counts || !outline) return 0;
  const total = counts[0] + counts[1] + counts[2];
  if (g >= total - 1) return 1;
  if (samples[g] && samples[g].length >= 3) return median(samples[g]);
  const bounds = [0, outline.sectors[0], outline.sectors[1], 1];
  let k = 0, j = g;
  while (j >= counts[k]) { j -= counts[k]; k++; }
  return bounds[k] + (bounds[k + 1] - bounds[k]) * (j + 1) / counts[k];
}
function carEst(n) { return est[n] || (est[n] = { g: -1, frac: 0, ts: 0, lapStart: 0, passes: {}, lastLapMs: 0 }); }
function anchor(n, g, ts) { const e = carEst(n); e.g = g; e.frac = g < 0 ? 0 : segEnd(g); e.ts = ts; }
// 越過起終點線：開始新的一圈；同時用上一圈各小段的通過時間校正小段位置
function startLap(n, ts) {
  const e = carEst(n);
  if (ts - e.lapStart < 5000) return;
  const lapMs = ts - e.lapStart;
  const ref = (outline?.lapSec || 90) * 1000;
  if (e.lapStart && lapMs > ref * 0.85 && lapMs < ref * 1.25) {
    Object.entries(e.passes).forEach(([g, t]) => {
      const f = (t - e.lapStart) / lapMs;
      if (f > 0 && f < 1) { (samples[g] = samples[g] || []).push(f); if (samples[g].length > 40) samples[g].shift(); }
    });
    e.lastLapMs = lapMs;
  } else if (e.lapStart && lapMs > ref * 0.85 && lapMs < ref * 2.5) e.lastLapMs = lapMs;
  e.lapStart = ts; e.passes = {};
  anchor(n, -1, ts);
}
// 從 TimingData 的更新判斷車輛剛通過哪個小段、區段或起終點線
function onTimingDelta(delta, ts) {
  const counts = segLayout();
  Object.entries(delta.Lines || {}).forEach(([n, l]) => {
    if (l.NumberOfLaps != null) startLap(n, ts);
    const secs = l.Sectors ? (Array.isArray(l.Sectors) ? Object.entries(l.Sectors) : Object.entries(l.Sectors)) : [];
    secs.forEach(([k, s]) => {
      k = Number(k);
      if (!s || !counts) return;
      const offset = k === 0 ? 0 : k === 1 ? counts[0] : counts[0] + counts[1];
      let best = -1;
      Object.entries(s.Segments || {}).forEach(([j, seg]) => { if (seg && seg.Status) best = Math.max(best, Number(j)); });
      if (best >= 0) {
        const g = offset + best;
        if (g >= counts[0] + counts[1] + counts[2] - 1) startLap(n, ts);
        else { anchor(n, g, ts); carEst(n).passes[g] = ts; }
      }
      if (s.Value && k < 2) { const g = offset + counts[k] - 1; if (carEst(n).g < g) anchor(n, g, ts); }
      if (s.Value && k === 2) startLap(n, ts);
    });
  });
}
function carPosition(n, line) {
  const e = est[n];
  const st = state.SessionStatus?.Status;
  if (!outline || !e || !e.ts || line.Retired || line.Stopped || !['Started', 'Finished', 'Ends'].includes(st)) return null;
  if (line.InPit) return { frac: 0, ts: Math.round(e.ts), rate: 0, cap: 0, pit: true };
  // 預估一圈要多久：用自己上一圈；安全車、虛擬安全車時放慢
  let lapMs = e.lastLapMs || (outline.lapSec * 1000 * 1.06);
  if (['4', '6', '7'].includes(String(state.TrackStatus?.Status))) lapMs = Math.max(lapMs, outline.lapSec * 1000 * 1.4);
  // 最多只能推進到下一個小段的終點：還沒收到通過訊號，就不會超過它
  const counts = segLayout();
  const total = counts ? counts[0] + counts[1] + counts[2] : 1;
  const cap = e.g + 1 >= total - 1 ? 1 : segEnd(e.g + 1);
  // 數字取到夠用的位數，減少傳輸量
  return { frac: +e.frac.toFixed(4), ts: Math.round(e.ts), rate: +(1 / lapMs).toPrecision(4), cap: +cap.toFixed(4) };
}

/* ================= 無線電轉錄 ================= */
const radioText = {};
const radioQueue = new Set();
let worker = null;
const transcriptPath = join(root, 'data', 'radioTranscripts.json');
let saveTimer = null;
function startWorker() {
  const py = join(homedir(), '.local/share/lights-out-whisper/bin/python');
  if (!existsSync(py)) { log('⚠️ 找不到 Whisper 環境，無線電不會轉成文字（安裝方式見 scripts/transcribeRadio.py）'); return; }
  worker = spawn(py, [join(root, 'scripts', 'radioWorker.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: worker.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) { log(`🎙️ Whisper 已就緒（${m.model}）`); return; }
    radioQueue.delete(m.url);
    if (m.error) { log('無線電轉錄失敗：', m.error); return; }
    radioText[m.url] = m.text;
    log(`🎙️ ${m.text.slice(0, 70)}`);
    dirty.radio = true;
    // 正賽的文字稿順便存進網站的文字稿檔，賽後回放就不用再轉一次
    if (state.SessionInfo?.Type === 'Race' && !clock.replay) { clearTimeout(saveTimer); saveTimer = setTimeout(saveTranscripts, 5000); }
  });
  worker.on('exit', (code) => { log(`Whisper 程式結束（${code}）`); worker = null; });
}
function saveTranscripts() {
  try {
    const data = existsSync(transcriptPath) ? JSON.parse(readFileSync(transcriptPath, 'utf8')) : { transcripts: {} };
    Object.assign(data.transcripts, radioText);
    data.updatedAt = new Date().toISOString().slice(0, 19) + '+00:00';
    const out = { updatedAt: data.updatedAt, transcripts: Object.fromEntries(Object.entries(data.transcripts).sort(([a], [b]) => (a < b ? -1 : 1))) };
    writeFileSync(transcriptPath, JSON.stringify(out, null, 1) + '\n');
  } catch (e) { log('寫入文字稿失敗：', e.message); }
}
const radioUrl = (c) => `${feedBase}/static/${state.SessionInfo?.Path || ''}${c.Path}`;
function queueRadio(captures) {
  if (!worker) return;
  captures.forEach((c) => { const url = radioUrl(c); if (c.Path && !(url in radioText) && !radioQueue.has(url)) { radioQueue.add(url); worker.stdin.write(url + '\n'); } });
}

/* ================= 處理每一筆資料 ================= */
const dirty = { session: true, cars: true, rc: true, radio: true, outline: true };
function handle(topic, data, ts, full) {
  if (topic === 'TimingData' && !full) onTimingDelta(data, ts);
  if (full) state[topic] = data; else { state[topic] = state[topic] || {}; merge(state[topic], data); }
  if (topic === 'SessionInfo') {
    const key = state.SessionInfo?.Meeting?.Circuit?.Key;
    const o = outlines[key];
    if (o !== outline) { outline = o || null; dirty.outline = true; log(outline ? `🗺️ 賽道：${outline.name}` : `⚠️ 沒有這條賽道（代碼 ${key}）的輪廓，執行 node scripts/buildTrackOutlines.mjs 產生`); }
    dirty.session = true;
  }
  if (topic === 'TeamRadio') {
    const caps = vals(state.TeamRadio?.Captures);
    // 剛連上時只轉最近 8 段，之後新進的每段都轉
    queueRadio(full ? caps.slice(-8) : vals(data.Captures));
    dirty.radio = true;
  }
  if (topic === 'RaceControlMessages') dirty.rc = true;
  if (['TimingData', 'TimingAppData', 'DriverList', 'TrackStatus', 'SessionStatus'].includes(topic)) dirty.cars = true;
  if (['SessionStatus', 'TrackStatus', 'LapCount', 'ExtrapolatedClock', 'WeatherData', 'SessionInfo'].includes(topic)) dirty.session = true;
}

/* ================= 給網頁的資料 ================= */
function viewSession() {
  const si = state.SessionInfo || {}; const clockInfo = state.ExtrapolatedClock || {}; const w = state.WeatherData || {};
  // 剩餘時間：換算成「到某個時刻為止」，網頁自己倒數
  const [h, m, s] = String(clockInfo.Remaining || '0:0:0').split(':').map(Number);
  const remainMs = ((h || 0) * 3600 + (m || 0) * 60 + (s || 0)) * 1000;
  const sinceUtc = clockInfo.Extrapolating && clockInfo.Utc ? Math.max(0, now() - Date.parse(clockInfo.Utc)) : 0;
  return {
    meeting: si.Meeting?.Name, official: si.Meeting?.OfficialName, country: si.Meeting?.Country?.Name, type: si.Type, name: si.Name, circuitKey: si.Meeting?.Circuit?.Key,
    status: state.SessionStatus?.Status, track: state.TrackStatus?.Status, trackMsg: state.TrackStatus?.Message,
    lap: state.LapCount?.CurrentLap, totalLaps: state.LapCount?.TotalLaps,
    remainMs: Math.max(0, remainMs - sinceUtc), clockRunning: !!clockInfo.Extrapolating,
    weather: { air: w.AirTemp, track: w.TrackTemp, hum: w.Humidity, rain: w.Rainfall, wind: w.WindSpeed, windDir: w.WindDirection, pressure: w.Pressure },
  };
}
function viewCars() {
  const lines = state.TimingData?.Lines || {}; const app = state.TimingAppData?.Lines || {}; const dl = state.DriverList || {};
  return Object.entries(lines).map(([n, l]) => {
    const d = dl[n] || {}; const stints = vals(app[n]?.Stints); const st = stints[stints.length - 1];
    const stat = vals(l.Stats); const lastStat = stat[stat.length - 1] || {};
    const bestQ = vals(l.BestLapTimes).map((b) => b?.Value).filter(Boolean);
    return {
      n, pos: Number(l.Position) || 99, tla: d.Tla || n, name: d.LastName || '', col: d.TeamColour || '999999',
      gap: l.GapToLeader ?? lastStat.TimeDiffToFastest ?? '', int: l.IntervalToPositionAhead?.Value ?? lastStat.TimeDifftoPositionAhead ?? '',
      last: { v: l.LastLapTime?.Value || '', pb: !!l.LastLapTime?.PersonalFastest, ob: !!l.LastLapTime?.OverallFastest },
      best: l.BestLapTime?.Value || bestQ[bestQ.length - 1] || '',
      sec: vals(l.Sectors).map((s) => ({ v: s.Value || '', prev: s.PreviousValue || '', pb: !!s.PersonalFastest, ob: !!s.OverallFastest, segs: vals(s.Segments).map((x) => x?.Status || 0) })),
      tyre: st?.Compound || '', tyreAge: st?.TotalLaps ?? null, tyreNew: st?.New === 'true',
      pit: !!l.InPit, pitOut: !!l.PitOut, out: !!(l.Retired || l.Stopped), knocked: !!l.KnockedOut, laps: l.NumberOfLaps ?? null, stops: l.NumberOfPitStops ?? null,
      est: carPosition(n, l),
    };
  }).sort((a, b) => a.pos - b.pos);
}
const viewRc = () => vals(state.RaceControlMessages?.Messages).slice(-40).map((m) => ({ utc: m.Utc, lap: m.Lap, cat: m.Category, flag: m.Flag, scope: m.Scope, msg: m.Message }));
const viewRadio = () => vals(state.TeamRadio?.Captures).slice(-60).map((c) => { const url = radioUrl(c); return { n: c.RacingNumber, utc: c.Utc, text: radioText[url] ?? null, pending: radioQueue.has(url) }; });
const viewOutline = () => outline && { key: state.SessionInfo?.Meeting?.Circuit?.Key, name: outline.name, sectors: outline.sectors, pts: outline.pts };

/* ================= 推送給網頁（Server-Sent Events） ================= */
const clients = new Set();
const lastSent = {};
function snapshot() { return { now: now(), speed: clock.replay ? speed : 1, replay: clock.replay, session: viewSession(), cars: viewCars(), rc: viewRc(), radio: viewRadio(), outline: viewOutline() }; }
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
setInterval(() => {
  if (!clients.size) return;
  const msg = { now: now() };
  if (dirty.session) { msg.session = viewSession(); dirty.session = false; }
  if (dirty.rc) { msg.rc = viewRc(); dirty.rc = false; }
  if (dirty.radio) { msg.radio = viewRadio(); dirty.radio = false; }
  if (dirty.outline) { msg.outline = viewOutline(); dirty.outline = false; }
  if (dirty.cars) {
    // 只送每台車有變動的欄位，減少上傳流量（網頁端再合併）
    const changed = [];
    viewCars().forEach((c) => {
      const prev = lastSent[c.n] || {}; const diff = {}; const next = {};
      Object.entries(c).forEach(([k, v]) => { const s = JSON.stringify(v); next[k] = s; if (prev[k] !== s) diff[k] = v; });
      lastSent[c.n] = next;
      if (Object.keys(diff).length) changed.push({ n: c.n, ...diff });
    });
    if (changed.length) msg.cars = changed;
    dirty.cars = false;
  }
  const data = `event: update\ndata: ${JSON.stringify(msg)}\n\n`;
  clients.forEach((res) => res.write(data));
}, 1000);
// 每 15 秒送一次心跳，避免連線被中間的代理伺服器切斷
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = req.url.split('?')[0];
  if (path === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    send(res, 'snapshot', snapshot());
    clients.add(res);
    log(`👀 觀看人數 ${clients.size}`);
    req.on('close', () => { clients.delete(res); });
    return;
  }
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, session: viewSession(), viewers: clients.size, replay: clock.replay }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Lights Out 比賽即時轉送程式運作中。資料串流：/stream，狀態：/health\n');
}).listen(port, () => log(`🚦 本機伺服器：http://localhost:${port}`));

/* ================= 連線官方資料流 ================= */
let recorder = null;
function record(ts, topic, data, full) { if (recorder) recorder.write(JSON.stringify(full ? [ts, topic, data, 1] : [ts, topic, data]) + '\n'); }
let lastMsgAt = Date.now();
let ws = null;
async function connectFeed() {
  try {
    const neg = await fetch(`${feedBase}/signalrcore/negotiate?negotiateVersion=1`, { method: 'POST' });
    if (!neg.ok) throw new Error(`negotiate HTTP ${neg.status}`);
    const cookie = neg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const { connectionToken } = await neg.json();
    ws = new WebSocket(`wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(connectionToken)}`, { headers: { Cookie: cookie } });
  } catch (e) { log('連線失敗，5 秒後重試：', e.message); setTimeout(connectFeed, 5000); return; }
  ws.onopen = () => {
    ws.send('{"protocol":"json","version":1}\x1e');
    ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [topics], invocationId: 'sub' }) + '\x1e');
    log('📡 已連上 F1 官方即時資料流');
  };
  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    for (const raw of String(ev.data).split('\x1e')) {
      if (!raw) continue;
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.type === 3 && m.invocationId === 'sub') {
        if (m.error) { log('訂閱失敗：', m.error); continue; }
        const ts = Date.now();
        Object.entries(m.result || {}).forEach(([topic, data]) => { if (data && Object.keys(data).length) { record(ts, topic, data, true); handle(topic, data, ts, true); } });
        const si = state.SessionInfo;
        if (si) log(`🏁 ${si.Meeting?.Name}・${si.Name}（狀態：${state.SessionStatus?.Status}）`);
      } else if (m.type === 1 && Array.isArray(m.arguments)) {
        const [topic, data, when] = m.arguments;
        if (!topics.includes(topic) || !data) continue;
        const ts = Date.now();
        record(ts, topic, data, false);
        handle(topic, data, ts, false);
        if (when && topic === 'SessionStatus') log(`🏁 賽事狀態：${state.SessionStatus?.Status}`);
      } else if (m.type === 7) log('伺服器關閉連線', m.error || '');
    }
  };
  ws.onclose = () => { log('資料流中斷，3 秒後重新連線'); ws = null; setTimeout(connectFeed, 3000); };
  ws.onerror = () => {};
}
// SignalR 需要用戶端定期送 ping；超過 90 秒沒收到任何資料就重連
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  ws.send('{"type":6}\x1e');
  if (Date.now() - lastMsgAt > 90000) { log('超過 90 秒沒有資料，重新連線'); lastMsgAt = Date.now(); ws.close(); }
}, 15000);

/* ================= 重播錄下的資料 ================= */
async function replay(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!lines.length) { log('錄製檔是空的'); return; }
  // 從錄製檔開頭（剛連上資料流的時刻）開始重播；開頭的完整狀態立刻套用
  const startAt = lines[0][0] + skipMin * 60000;
  clock = { replay: true, base: startAt, realBase: Date.now() };
  log(`⏯️ 重播 ${file}（${speed} 倍速${skipMin ? `，跳過 ${skipMin} 分鐘` : ''}）`);
  for (const [ts, topic, data, full] of lines) {
    if (!full && ts > now()) await new Promise((r) => setTimeout(r, Math.max(0, (ts - now()) / speed)));
    handle(topic, data, ts, !!full);
  }
  log('⏹️ 重播結束（伺服器繼續運作，Ctrl+C 結束）');
}

/* ================= Cloudflare 通道與發布網址 ================= */
function findCloudflared() {
  const candidates = [join(homedir(), '.local/bin/cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  return candidates.find((p) => existsSync(p)) || 'cloudflared';
}
function startTunnel() {
  return new Promise((resolve) => {
    const cf = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) { done = true; log(`🌐 Cloudflare 通道：${m[0]}`); resolve(m[0]); }
    };
    cf.stdout.on('data', onData); cf.stderr.on('data', onData);
    cf.on('error', () => { log('⚠️ 找不到 cloudflared，無法開通道（安裝方式見 CLAUDE.md）'); resolve(null); });
    cf.on('exit', (code) => { if (!done) resolve(null); else log(`⚠️ Cloudflare 通道結束（${code}）`); });
    process.on('exit', () => cf.kill());
  });
}
const endpointPath = join(root, 'data', 'liveEndpoint.json');
function publishEndpoint(url) {
  const si = state.SessionInfo;
  const body = url
    ? { url, meeting: si?.Meeting?.Name || null, session: si?.Name || null, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 3600000).toISOString() }
    : { url: null, endedAt: new Date().toISOString() };
  writeFileSync(endpointPath, JSON.stringify(body, null, 1) + '\n');
  try {
    // 只提交這一個檔案，不會帶到其他未提交的修改
    execFileSync('git', ['-C', root, 'add', 'data/liveEndpoint.json']);
    execFileSync('git', ['-C', root, 'commit', '-m', url ? `chore: 直播開始（${body.meeting || '賽事'} ${body.session || ''}）` : 'chore: 直播結束', '--', 'data/liveEndpoint.json'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'push', 'origin', 'HEAD'], { stdio: 'ignore' });
    log(url ? '✅ 已發布直播網址，網站約 1 分鐘後切換成直播' : '✅ 已撤下直播網址');
  } catch (e) { log('⚠️ 推上 GitHub 失敗，請手動提交 data/liveEndpoint.json：', e.message.split('\n')[0]); }
}

/* ================= 啟動 ================= */
if (process.platform === 'darwin' && !replayFile) {
  // 防止 Mac 在比賽中途進入睡眠
  spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
}
if (useRadio) startWorker();
if (replayFile) replay(replayFile);
else {
  if (useRecord) {
    mkdirSync(join(root, 'recordings'), { recursive: true });
    const file = join(root, 'recordings', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`);
    recorder = createWriteStream(file, { flags: 'a' });
    log(`💾 錄製到 ${file}`);
  }
  connectFeed();
}
let published = false;
if (flag('--tunnel')) {
  startTunnel().then(async (url) => {
    if (!url || !flag('--publish')) return;
    // 等通道真的能連通再發布（新通道的網址要幾秒才會生效）
    for (let i = 0; i < 30; i++) {
      try { const r = await fetch(`${url}/health`); if (r.ok) break; } catch { /* 還沒生效 */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    publishEndpoint(url); published = true;
  });
}
let stopping = false;
async function shutdown() {
  if (stopping) process.exit(0);
  stopping = true;
  log('結束中…（再按一次 Ctrl+C 強制結束）');
  if (published) publishEndpoint(null);
  if (Object.keys(radioText).length && state.SessionInfo?.Type === 'Race' && !clock.replay) saveTranscripts();
  if (worker) worker.kill();
  if (recorder) recorder.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
