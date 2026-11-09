"""
即時無線電轉錄小幫手：由 scripts/liveRelay.mjs 啟動，不需要手動執行。

從標準輸入每行讀一個錄音網址，下載後用 Whisper 轉成英文文字，
每完成一段就從標準輸出印一行 JSON：{"url": ..., "text": ...}
模型只載入一次，所以每段十幾秒的錄音通常幾秒內就能轉好。
"""
import json
import os
import sys
import tempfile

import requests
from faster_whisper import WhisperModel

modelName = os.environ.get('WHISPER_MODEL', 'small.en')
headers = {'User-Agent': 'lights-out-f1-fan-site (github.com/YuchiangKo/claude-lab)'}


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    model = WhisperModel(modelName, device='cpu', compute_type='int8')
    reply({'ready': True, 'model': modelName})
    for line in sys.stdin:
        url = line.strip()
        if not url:
            continue
        try:
            audio = requests.get(url, headers=headers, timeout=30)
            audio.raise_for_status()
            with tempfile.NamedTemporaryFile(suffix='.mp3') as tmp:
                tmp.write(audio.content)
                tmp.flush()
                segments, _ = model.transcribe(tmp.name, language='en', beam_size=5, vad_filter=True)
                text = ' '.join(seg.text.strip() for seg in segments).strip()
            reply({'url': url, 'text': text})
        except Exception as err:  # 單段失敗不影響其他段
            reply({'url': url, 'error': str(err)})


if __name__ == '__main__':
    main()
