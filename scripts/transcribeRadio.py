"""
車隊無線電轉文字：
從 OpenF1 取得 2026 年已結束正賽的車隊無線電錄音，用 Whisper（faster-whisper）轉成英文文字，
存到 data/radioTranscripts.json，網頁的「賽道即時」分頁會讀取這個檔案。
錄音檔本身不會存下來，只保留文字。

在本機執行（F1 的錄音伺服器會拒絕雲端機房的下載，所以無法放在 GitHub Actions 上跑）：
  1. 第一次安裝：python3 -m venv ~/.local/share/lights-out-whisper
                 ~/.local/share/lights-out-whisper/bin/pip install -r scripts/requirements.txt
  2. 每場比賽結束後：~/.local/share/lights-out-whisper/bin/python scripts/transcribeRadio.py
     已轉過的錄音會略過，只處理新的；完成後提交 data/radioTranscripts.json 並推上 GitHub。
"""
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import requests
from faster_whisper import WhisperModel

season = 2026
apiBase = 'https://api.openf1.org/v1'
outPath = os.path.join(os.path.dirname(__file__), '..', 'data', 'radioTranscripts.json')
maxClipsPerRun = int(os.environ.get('MAX_CLIPS', '400'))  # 每次執行最多轉幾段，避免單次執行過久
modelName = os.environ.get('WHISPER_MODEL', 'small.en')
headers = {'User-Agent': 'lights-out-f1-fan-site (github.com/YuchiangKo/claude-lab)'}


def getJson(path):
    """呼叫 OpenF1，遇到請求過於頻繁時自動重試"""
    for attempt in range(6):
        res = requests.get(f'{apiBase}/{path}', headers=headers, timeout=60)
        if res.status_code == 404:
            return []
        if res.status_code == 429:
            time.sleep(5 * (attempt + 1))
            continue
        res.raise_for_status()
        return res.json()
    raise RuntimeError(f'OpenF1 請求失敗：{path}')


def loadExisting():
    """讀取已轉好的文字稿，已處理過的錄音不再重轉"""
    if os.path.exists(outPath):
        with open(outPath, encoding='utf-8') as f:
            return json.load(f)
    return {'updatedAt': None, 'transcripts': {}}


def saveData(data):
    data['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    # 依網址排序後寫入；不替換 data['transcripts'] 本身，避免之後新增的文字稿寫到舊的資料表
    output = {'updatedAt': data['updatedAt'], 'transcripts': dict(sorted(data['transcripts'].items()))}
    os.makedirs(os.path.dirname(outPath), exist_ok=True)
    with open(outPath, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=1)
        f.write('\n')


def main():
    data = loadExisting()
    done = data['transcripts']
    now = datetime.now(timezone.utc)

    # 只處理已結束超過 1 小時的正賽（OpenF1 賽後資料需要一點時間才完整）
    sessions = [s for s in getJson(f'sessions?year={season}&session_type=Race')
                if s['session_name'] == 'Race' and datetime.fromisoformat(s['date_end']) < now - timedelta(hours=1)]
    sessions.sort(key=lambda s: s['date_start'], reverse=True)  # 最新的比賽優先

    pending = []
    for s in sessions:
        clips = getJson(f"team_radio?session_key={s['session_key']}")
        pending += [c['recording_url'] for c in clips if c.get('recording_url') and c['recording_url'] not in done]
        time.sleep(1)
    print(f'共 {len(sessions)} 場已結束正賽，待轉錄 {len(pending)} 段無線電')
    if not pending:
        return 0

    model = WhisperModel(modelName, device='cpu', compute_type='int8')
    for i, url in enumerate(pending[:maxClipsPerRun], 1):
        try:
            audio = requests.get(url, headers=headers, timeout=60)
            audio.raise_for_status()
            with tempfile.NamedTemporaryFile(suffix='.mp3') as tmp:
                tmp.write(audio.content)
                tmp.flush()
                segments, _ = model.transcribe(tmp.name, language='en', beam_size=5, vad_filter=True)
                text = ' '.join(seg.text.strip() for seg in segments).strip()
            # 沒有辨識出內容時存空字串，避免下次重複處理
            done[url] = text
            print(f'[{i}/{min(len(pending), maxClipsPerRun)}] {text[:80]}')
        except Exception as err:  # 單段失敗不影響其他段
            print(f'轉錄失敗，下次再試：{url}（{err}）', file=sys.stderr)
        if i % 25 == 0:
            saveData(data)  # 定期存檔，執行中斷也不會全部重來
    saveData(data)
    return 0


if __name__ == '__main__':
    sys.exit(main())
