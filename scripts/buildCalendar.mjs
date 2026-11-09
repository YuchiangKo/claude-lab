/*
產生 2027 賽季行事曆檔（iCalendar 格式）：calendar/f1-2027.ics
同一個檔案同時用於「訂閱」（webcal，會自動更新）與「下載匯入」（.ics）。

事件名稱格式：「巴西大獎賽 一練」；地點為賽道與城市；開始前 5 分鐘提醒。
時間一律以 UTC 寫入，行事曆 App 會依使用者所在時區顯示；備註中另外列出當地時間與台灣時間。

官方尚未公布 2027 各節時間前，以各賽道 2026 年的正賽當地時刻為準，
再依 F1 固定的週末時程往前推算其他各節（標為「暫定」）。
官方公布後：在該站填入 sessions（當地時間），並把 confirmed 設為 true，重新執行即可。

執行：node scripts/buildCalendar.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const season = 2027;
const siteUrl = 'https://yuchiangko.github.io/claude-lab/';
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'calendar', `f1-${season}.ics`);
const alarmMinutes = 5;

// 各節名稱與長度（分鐘）
const sessionInfo = {
  fp1: { zh: '一練', minutes: 60 },
  fp2: { zh: '二練', minutes: 60 },
  fp3: { zh: '三練', minutes: 60 },
  sprintQuali: { zh: '衝刺排位賽', minutes: 45 },
  sprint: { zh: '衝刺賽', minutes: 45 },
  quali: { zh: '排位賽', minutes: 60 },
  race: { zh: '正賽', minutes: 120 }
};

// F1 固定的週末時程：[節次, 距正賽日幾天, 距正賽開始時刻幾分鐘]
const normalWeekend = [['fp1', -2, -90], ['fp2', -2, 120], ['fp3', -1, -150], ['quali', -1, 60], ['race', 0, 0]];
const sprintWeekend = [['fp1', -2, -150], ['sprintQuali', -2, 90], ['sprint', -1, -180], ['quali', -1, 60], ['race', 0, 0]];

// 2027 賽程（2026-09-16 官方公布）。raceLocal：正賽當地開賽時刻（暫定，取自 2026 年同賽道；2026 年未舉辦的取近年慣例）
const rounds = [
  { round: 1, zh: '巴林大獎賽', circuitZh: '巴林國際賽道', circuitEn: 'Bahrain International Circuit', cityZh: '薩基爾', cityEn: 'Sakhir', countryZh: '巴林', countryEn: 'Bahrain', tz: 'Asia/Bahrain', raceDate: '2027-03-14', raceLocal: '18:00', sprint: true },
  { round: 2, zh: '沙烏地阿拉伯大獎賽', circuitZh: '吉達濱海賽道', circuitEn: 'Jeddah Corniche Circuit', cityZh: '吉達', cityEn: 'Jeddah', countryZh: '沙烏地阿拉伯', countryEn: 'Saudi Arabia', tz: 'Asia/Riyadh', raceDate: '2027-03-21', raceLocal: '20:00' },
  { round: 3, zh: '澳洲大獎賽', circuitZh: '亞伯特公園賽道', circuitEn: 'Albert Park Circuit', cityZh: '墨爾本', cityEn: 'Melbourne', countryZh: '澳洲', countryEn: 'Australia', tz: 'Australia/Melbourne', raceDate: '2027-04-04', raceLocal: '15:00', sprint: true },
  { round: 4, zh: '日本大獎賽', circuitZh: '鈴鹿賽道', circuitEn: 'Suzuka Circuit', cityZh: '鈴鹿', cityEn: 'Suzuka', countryZh: '日本', countryEn: 'Japan', tz: 'Asia/Tokyo', raceDate: '2027-04-11', raceLocal: '14:00', sprint: true },
  { round: 5, zh: '中國大獎賽', circuitZh: '上海國際賽車場', circuitEn: 'Shanghai International Circuit', cityZh: '上海', cityEn: 'Shanghai', countryZh: '中國', countryEn: 'China', tz: 'Asia/Shanghai', raceDate: '2027-04-18', raceLocal: '15:00' },
  { round: 6, zh: '邁阿密大獎賽', circuitZh: '邁阿密國際賽車場', circuitEn: 'Miami International Autodrome', cityZh: '邁阿密', cityEn: 'Miami Gardens', countryZh: '美國', countryEn: 'USA', tz: 'America/New_York', raceDate: '2027-05-02', raceLocal: '16:00' },
  { round: 7, zh: '加拿大大獎賽', circuitZh: 'Gilles Villeneuve 賽道', circuitEn: 'Circuit Gilles Villeneuve', cityZh: '蒙特婁', cityEn: 'Montreal', countryZh: '加拿大', countryEn: 'Canada', tz: 'America/Toronto', raceDate: '2027-05-23', raceLocal: '16:00', sprint: true },
  { round: 8, zh: '摩納哥大獎賽', circuitZh: '蒙地卡羅街道賽道', circuitEn: 'Circuit de Monaco', cityZh: '蒙地卡羅', cityEn: 'Monte Carlo', countryZh: '摩納哥', countryEn: 'Monaco', tz: 'Europe/Monaco', raceDate: '2027-06-06', raceLocal: '15:00', sprint: true },
  { round: 9, zh: '葡萄牙大獎賽', circuitZh: '阿爾加維國際賽道', circuitEn: 'Algarve International Circuit', cityZh: '波爾蒂芒', cityEn: 'Portimão', countryZh: '葡萄牙', countryEn: 'Portugal', tz: 'Europe/Lisbon', raceDate: '2027-06-20', raceLocal: '15:00' },
  { round: 10, zh: '英國大獎賽', circuitZh: '銀石賽道', circuitEn: 'Silverstone Circuit', cityZh: '銀石', cityEn: 'Silverstone', countryZh: '英國', countryEn: 'United Kingdom', tz: 'Europe/London', raceDate: '2027-07-04', raceLocal: '15:00', sprint: true },
  { round: 11, zh: '奧地利大獎賽', circuitZh: 'Red Bull Ring', circuitEn: 'Red Bull Ring', cityZh: '斯皮爾伯格', cityEn: 'Spielberg', countryZh: '奧地利', countryEn: 'Austria', tz: 'Europe/Vienna', raceDate: '2027-07-11', raceLocal: '15:00' },
  { round: 12, zh: '比利時大獎賽', circuitZh: '斯帕賽道', circuitEn: 'Circuit de Spa-Francorchamps', cityZh: '斯塔沃洛', cityEn: 'Stavelot', countryZh: '比利時', countryEn: 'Belgium', tz: 'Europe/Brussels', raceDate: '2027-07-25', raceLocal: '15:00' },
  { round: 13, zh: '匈牙利大獎賽', circuitZh: '匈牙利賽道', circuitEn: 'Hungaroring', cityZh: '莫焦羅德', cityEn: 'Mogyoród', countryZh: '匈牙利', countryEn: 'Hungary', tz: 'Europe/Budapest', raceDate: '2027-08-01', raceLocal: '15:00' },
  { round: 14, zh: '義大利大獎賽', circuitZh: '蒙札賽道', circuitEn: 'Autodromo Nazionale Monza', cityZh: '蒙札', cityEn: 'Monza', countryZh: '義大利', countryEn: 'Italy', tz: 'Europe/Rome', raceDate: '2027-09-05', raceLocal: '15:00', sprint: true },
  { round: 15, zh: '西班牙大獎賽', circuitZh: '馬德里 Madring 賽道', circuitEn: 'Madring', cityZh: '馬德里', cityEn: 'Madrid', countryZh: '西班牙', countryEn: 'Spain', tz: 'Europe/Madrid', raceDate: '2027-09-12', raceLocal: '15:00' },
  { round: 16, zh: '亞塞拜然大獎賽', circuitZh: '巴庫街道賽道', circuitEn: 'Baku City Circuit', cityZh: '巴庫', cityEn: 'Baku', countryZh: '亞塞拜然', countryEn: 'Azerbaijan', tz: 'Asia/Baku', raceDate: '2027-09-26', raceLocal: '15:00' },
  { round: 17, zh: '土耳其大獎賽', circuitZh: '伊斯坦堡公園賽道', circuitEn: 'Istanbul Park', cityZh: '伊斯坦堡', cityEn: 'Istanbul', countryZh: '土耳其', countryEn: 'Türkiye', tz: 'Europe/Istanbul', raceDate: '2027-10-03', raceLocal: '15:00' },
  { round: 18, zh: '新加坡大獎賽', circuitZh: '濱海灣街道賽道', circuitEn: 'Marina Bay Street Circuit', cityZh: '新加坡', cityEn: 'Singapore', countryZh: '新加坡', countryEn: 'Singapore', tz: 'Asia/Singapore', raceDate: '2027-10-10', raceLocal: '20:00' },
  { round: 19, zh: '美國大獎賽', circuitZh: '美洲賽道', circuitEn: 'Circuit of the Americas', cityZh: '奧斯汀', cityEn: 'Austin', countryZh: '美國', countryEn: 'USA', tz: 'America/Chicago', raceDate: '2027-10-24', raceLocal: '15:00' },
  { round: 20, zh: '墨西哥大獎賽', circuitZh: '羅德里格斯兄弟賽道', circuitEn: 'Autódromo Hermanos Rodríguez', cityZh: '墨西哥城', cityEn: 'Mexico City', countryZh: '墨西哥', countryEn: 'Mexico', tz: 'America/Mexico_City', raceDate: '2027-10-31', raceLocal: '14:00' },
  { round: 21, zh: '巴西大獎賽', circuitZh: '英特拉格斯賽道', circuitEn: 'Autódromo José Carlos Pace (Interlagos)', cityZh: '聖保羅', cityEn: 'São Paulo', countryZh: '巴西', countryEn: 'Brazil', tz: 'America/Sao_Paulo', raceDate: '2027-11-07', raceLocal: '14:00', sprint: true },
  // 拉斯維加斯在週六晚上比賽，週末是週四到週六
  { round: 22, zh: '拉斯維加斯大獎賽', circuitZh: '拉斯維加斯大道賽道', circuitEn: 'Las Vegas Strip Circuit', cityZh: '拉斯維加斯', cityEn: 'Las Vegas', countryZh: '美國', countryEn: 'USA', tz: 'America/Los_Angeles', raceDate: '2027-11-20', raceLocal: '20:00' },
  { round: 23, zh: '卡達大獎賽', circuitZh: '盧賽爾國際賽道', circuitEn: 'Lusail International Circuit', cityZh: '盧賽爾', cityEn: 'Lusail', countryZh: '卡達', countryEn: 'Qatar', tz: 'Asia/Qatar', raceDate: '2027-12-05', raceLocal: '19:00', sprint: true },
  { round: 24, zh: '阿布達比大獎賽', circuitZh: '亞斯碼頭賽道', circuitEn: 'Yas Marina Circuit', cityZh: '阿布達比', cityEn: 'Abu Dhabi', countryZh: '阿拉伯聯合大公國', countryEn: 'UAE', tz: 'Asia/Dubai', raceDate: '2027-12-12', raceLocal: '17:00', sprint: true }
];

const pad2 = (n) => String(n).padStart(2, '0');
const weekdayZh = ['日', '一', '二', '三', '四', '五', '六'];

// 某個時刻在指定時區的「牆上時間」（以 UTC 欄位表示）
function wallClock(utcMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}
// 當地日期＋時刻 → UTC 毫秒（自動處理夏令時間）
function localToUtc(dateStr, minutesOfDay, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - wallClock(guess, tz);
  return guess;
}
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
function formatWall(utcMs, tz) {
  const w = new Date(wallClock(utcMs, tz));
  return `${w.getUTCFullYear()}/${w.getUTCMonth() + 1}/${w.getUTCDate()}（${weekdayZh[w.getUTCDay()]}）${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}`;
}
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

// iCalendar 規定每行不超過 75 位元組，超過要折行（續行以空白開頭），且不能切斷中文字
function foldLine(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// 算出每一站各節的 UTC 時間
function sessionsOf(r) {
  if (r.sessions) {
    return r.sessions.map(([key, date, time]) => {
      const [h, m] = time.split(':').map(Number);
      return { key, start: localToUtc(date, h * 60 + m, r.tz) };
    });
  }
  const [h, m] = r.raceLocal.split(':').map(Number);
  const raceMin = h * 60 + m;
  return (r.sprint ? sprintWeekend : normalWeekend).map(([key, dayOffset, minOffset]) =>
    ({ key, start: localToUtc(shiftDate(r.raceDate, dayOffset), raceMin + minOffset, r.tz) }));
}

const stamp = icsTime(Date.now());
const lines = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Lights Out//F1 Calendar//ZH-TW',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  `X-WR-CALNAME:F1 ${season} 賽季`,
  `X-WR-CALDESC:${icsText(`F1 ${season} 賽季全部練習賽、排位賽、衝刺賽與正賽。由 Lights Out 整理：${siteUrl}`)}`,
  'X-WR-TIMEZONE:Asia/Taipei',
  // 訂閱時建議的更新頻率
  'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  'X-PUBLISHED-TTL:PT12H'
];
let eventCount = 0;
for (const r of rounds) {
  for (const s of sessionsOf(r)) {
    const info = sessionInfo[s.key];
    const end = s.start + info.minutes * 60000;
    const desc = [
      `第 ${r.round} 站・${r.zh}`,
      `當地時間：${formatWall(s.start, r.tz)}`,
      `台灣時間：${formatWall(s.start, 'Asia/Taipei')}`,
      ...(r.confirmed ? [] : ['', `⚠️ 官方尚未公布 ${season} 年各節時間，這是暫定時間（參考 2026 年同賽道時刻推估）。官方公布後會更新；用「訂閱」加入的行事曆會自動改成正確時間。`]),
      '',
      `賽程與即時資訊：${siteUrl}#schedule`
    ].join('\n');
    lines.push(
      'BEGIN:VEVENT',
      // UID 固定不變，重新匯入或訂閱更新時才會更新原本的事件，而不是重複新增
      `UID:f1-${season}-r${pad2(r.round)}-${s.key}@yuchiangko.github.io`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(s.start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(`${r.zh} ${info.zh}`)}`,
      `LOCATION:${icsText(`${r.circuitZh}，${r.cityZh}，${r.countryZh}（${r.circuitEn}, ${r.cityEn}, ${r.countryEn}）`)}`,
      `DESCRIPTION:${icsText(desc)}`,
      `URL:${siteUrl}#schedule`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(`${r.zh} ${info.zh} 即將開始`)}`,
      `TRIGGER:-PT${alarmMinutes}M`,
      'END:VALARM',
      'END:VEVENT'
    );
    eventCount++;
  }
}
lines.push('END:VCALENDAR');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.map(foldLine).join('\r\n') + '\r\n');
console.log(`已產生 ${outPath}：${rounds.length} 站、${eventCount} 個事件`);
