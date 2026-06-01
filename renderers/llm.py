"""
YancoRead — Multi-backend LLM client (for translation / AI features).

All supported backends speak the OpenAI-compatible /v1/chat/completions API:
  • Ollama     (local)   http://localhost:11434/v1/chat/completions
  • LM Studio  (local)   http://localhost:1234/v1/chat/completions
  • OpenClaw   (CatByte)  http://localhost:18789/v1/chat/completions
  • OpenAI     (cloud)   https://api.openai.com/v1/chat/completions
  • Custom     (any OpenAI-compatible endpoint)

Config dict: {backend, endpoint, model, api_key}. Empty endpoint → the default
for the chosen backend.
"""

import logging

import requests

logger = logging.getLogger('yancoread.llm')

DEFAULTS = {
    'ollama':   {'endpoint': 'http://localhost:11434/v1/chat/completions', 'model': 'llama3.1'},
    'lmstudio': {'endpoint': 'http://localhost:1234/v1/chat/completions',   'model': 'local-model'},
    'openclaw': {'endpoint': 'http://localhost:18789/v1/chat/completions',  'model': 'openclaw/default'},
    'openai':   {'endpoint': 'https://api.openai.com/v1/chat/completions',  'model': 'gpt-4o-mini'},
    'custom':   {'endpoint': '', 'model': ''},
}


def resolve(cfg: dict) -> dict:
    """Fill in endpoint/model defaults for the chosen backend."""
    backend = (cfg.get('backend') or 'ollama').lower()
    d = DEFAULTS.get(backend, DEFAULTS['custom'])
    return {
        'backend': backend,
        'endpoint': (cfg.get('endpoint') or '').strip() or d['endpoint'],
        'model': (cfg.get('model') or '').strip() or d['model'],
        'api_key': (cfg.get('api_key') or '').strip(),
    }


def chat(cfg: dict, messages: list, timeout: int = 60, temperature: float = 0.2) -> str:
    c = resolve(cfg)
    if not c['endpoint']:
        raise ValueError('No LLM endpoint configured')
    headers = {'Content-Type': 'application/json'}
    if c['api_key']:
        headers['Authorization'] = 'Bearer ' + c['api_key']
    body = {'model': c['model'], 'messages': messages,
            'temperature': temperature, 'stream': False}
    r = requests.post(c['endpoint'], json=body, headers=headers, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    return data['choices'][0]['message']['content']


def _models_url(endpoint: str) -> str:
    """Derive the OpenAI-compatible /models URL from a chat endpoint."""
    if '/chat/completions' in endpoint:
        return endpoint.split('/chat/completions')[0].rstrip('/') + '/models'
    if '/v1' in endpoint:
        return endpoint.split('/v1')[0].rstrip('/') + '/v1/models'
    return endpoint.rstrip('/') + '/models'


def list_models(cfg: dict) -> dict:
    """Query the backend for its installed models (the 'smart dropdown')."""
    c = resolve(cfg)
    if not c['endpoint']:
        return {'ok': False, 'error': 'No endpoint configured', 'models': []}
    headers = {}
    if c['api_key']:
        headers['Authorization'] = 'Bearer ' + c['api_key']
    try:
        r = requests.get(_models_url(c['endpoint']), headers=headers, timeout=8)
        r.raise_for_status()
        data = r.json()
        rows = data.get('data', data) if isinstance(data, dict) else data
        ids = []
        for m in (rows or []):
            mid = m.get('id') if isinstance(m, dict) else m
            if mid:
                ids.append(mid)
        return {'ok': True, 'models': sorted(set(ids))}
    except requests.RequestException as e:
        return {'ok': False, 'error': f'Could not reach the backend: {e}', 'models': []}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'models': []}


def test_connection(cfg: dict) -> dict:
    try:
        reply = chat(cfg, [{'role': 'user', 'content': 'Reply with exactly: OK'}], timeout=8)
        c = resolve(cfg)
        return {'ok': True, 'model': c['model'], 'endpoint': c['endpoint'],
                'reply': (reply or '').strip()[:120]}
    except requests.RequestException as e:
        return {'ok': False, 'error': f'Could not reach the model: {e}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def _extract_json_array(s: str):
    import json
    s = (s or '').strip()
    if s.startswith('```'):
        s = s.strip('`')
        s = s.split('\n', 1)[1] if '\n' in s else s
    a, b = s.find('['), s.rfind(']')
    if a != -1 and b > a:
        return json.loads(s[a:b + 1])
    raise ValueError('no JSON array')


def translate_batch(cfg: dict, texts: list, target: str = 'English') -> list:
    """Translate many strings in ONE call. Returns a same-length list."""
    texts = [t for t in texts]
    if not texts:
        return []
    import json
    payload = json.dumps(texts, ensure_ascii=False)
    system = (f'Translate each string in this JSON array into {target}. '
              'Return ONLY a JSON array of the translations — same length, same order, '
              'no commentary, no transliteration.')
    try:
        out = chat(cfg, [{'role': 'system', 'content': system},
                         {'role': 'user', 'content': payload}], timeout=120)
        arr = _extract_json_array(out)
        if isinstance(arr, list) and len(arr) == len(texts):
            return [str(x) for x in arr]
    except Exception as e:
        logger.warning("batch translate failed, falling back per-item: %s", e)
    return [translate(cfg, t, target) for t in texts]


def vision_read(cfg: dict, image_bytes: bytes, rtl: bool = False, target: str = '') -> list:
    """Read a comic page IMAGE with a multimodal model — transcribe (and optionally
    translate) every bubble in reading order. Far better than Tesseract on stylized
    or hand-lettered art. Returns [{text, box:{x,y,w,h}, translated?}]."""
    import base64
    b64 = base64.b64encode(image_bytes).decode('ascii')
    order = 'right-to-left, top-to-bottom' if rtl else 'left-to-right, top-to-bottom'
    instr = (
        'You are reading a comic page. Find every speech bubble and caption. '
        f'List them in natural reading order ({order}). '
        'Return ONLY a JSON array — no prose, no code fences. Each element is an object: '
        '{"text": "<the original text exactly>", "box": {"x":0..1,"y":0..1,"w":0..1,"h":0..1}'
        + (f', "translation": "<the text translated into {target}>"' if target else '')
        + '}. box gives the bubble location as fractions of the image width/height.'
    )
    messages = [{'role': 'user', 'content': [
        {'type': 'text', 'text': instr},
        {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{b64}'}},
    ]}]
    out = chat(cfg, messages, timeout=180)
    arr = _extract_json_array(out)
    blocks = []
    for it in arr:
        if not isinstance(it, dict):
            continue
        text = str(it.get('text', '')).strip()
        if not text:
            continue
        box = it.get('box') or {}
        try:
            b = {'x': float(box.get('x', 0)), 'y': float(box.get('y', 0)),
                 'w': float(box.get('w', 0.25)), 'h': float(box.get('h', 0.07))}
        except (TypeError, ValueError):
            b = {'x': 0, 'y': 0, 'w': 0.25, 'h': 0.07}
        block = {'text': text, 'box': b}
        if target and it.get('translation'):
            block['translated'] = str(it['translation']).strip()
        blocks.append(block)
    return blocks


def vision_chat(cfg: dict, image_bytes: bytes, instruction: str,
                timeout: int = 120, mime: str = 'image/png') -> str:
    """Generic single-image multimodal call: send ONE image plus a text
    instruction and get back plain text. Powers the Image viewer's "describe",
    free-form text extraction, captioning, tagging and visual Q&A — unlike
    vision_read (which is locked to the comic OCR-JSON schema)."""
    import base64
    b64 = base64.b64encode(image_bytes).decode('ascii')
    messages = [{'role': 'user', 'content': [
        {'type': 'text', 'text': instruction},
        {'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,{b64}'}},
    ]}]
    out = chat(cfg, messages, timeout=timeout)
    return (out or '').strip()


def translate(cfg: dict, text: str, target: str = 'English') -> str:
    text = (text or '').strip()
    if not text:
        return ''
    system = (f'You are a precise comic-book translator. Translate the user text into {target}. '
              'Preserve tone and keep it concise. Output ONLY the translation — no quotes, '
              'no notes, no transliteration.')
    out = chat(cfg, [{'role': 'system', 'content': system},
                     {'role': 'user', 'content': text}], timeout=60)
    return (out or '').strip()
