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
import math
from urllib.parse import urlparse

import requests

logger = logging.getLogger('yancoread.llm')


def _validate_endpoint(url: str) -> None:
    """Reject a non-HTTP(S) or hostless LLM endpoint before any request is made.
    Defense-in-depth: a malformed or hostile endpoint can't coax the client into
    an unexpected request scheme (file://, etc.). Local backends (localhost) are
    intentionally allowed — they are the common case for this app."""
    parsed = urlparse(url or '')
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('Invalid LLM endpoint URL (must be http(s)://host/...).')

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
    _validate_endpoint(c['endpoint'])
    headers = {'Content-Type': 'application/json'}
    if c['api_key']:
        headers['Authorization'] = 'Bearer ' + c['api_key']
    body = {'model': c['model'], 'messages': messages,
            'temperature': temperature, 'stream': False}
    r = requests.post(c['endpoint'], json=body, headers=headers, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    try:
        return data['choices'][0]['message']['content']
    except (KeyError, IndexError, TypeError) as e:
        # A backend that returns an empty/garbled 'choices' shape must surface a
        # clean error, not an uncaught IndexError/KeyError deep in a caller.
        raise ValueError(f'LLM returned an unexpected response shape: {e}')


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
        _validate_endpoint(c['endpoint'])
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
    """Translate many strings in ONE context-aware call. Returns a same-length
    list (order preserved). Thin wrapper over translate_segments using positional
    ids — kept for existing callers (e.g. the comic Tesseract path)."""
    texts = [str(t) for t in texts]
    if not texts:
        return []
    segs = [{'id': i, 'text': t} for i, t in enumerate(texts)]
    res = translate_segments(cfg, segs, target)
    return [res.get(i, texts[i]) for i in range(len(texts))]


# Unambiguous AI-assistant refusal openings (English). Used ONLY to reject a
# per-item fallback that is clearly a refusal, not a translation — never applied
# to structured batch output (which may legitimately start with these words).
_REFUSAL_PREFIXES = ("i cannot", "i can't", "i am unable", "i'm unable",
                     "as an ai", "i am an ai", "i apologize", "i'm sorry, but")


def _looks_like_refusal(text: str) -> bool:
    t = (text or '').strip().lower()
    return any(t.startswith(p) for p in _REFUSAL_PREFIXES)


def _segment_messages(items, target, src, register, repair=False):
    import json
    src_clause = '' if (src or 'auto').lower() == 'auto' else f'from {src} '
    reg = (register or 'neutral').lower()
    system = (
        f'You are a professional translator. Translate each segment {src_clause}into '
        f'{target} in a {reg} register, preserving the author\'s tone and meaning. '
        'Translate idioms and figurative language as the natural equivalent in the '
        'target language — never a literal word-for-word gloss. Keep proper nouns, '
        'brand and product names, code, URLs, emails, file paths, numbers and dates '
        'unchanged. If the target is Arabic, use Modern Standard Arabic and do not '
        'transliterate words that can be translated. The input is JSON '
        '{"segments":[{"id":N,"text":"..."}]}. Return ONLY JSON '
        '{"segments":[{"id":N,"t":"<translation>"}]} — one object per input id, the '
        'SAME ids, no commentary and no code fences.'
    )
    if repair:
        system += (' The previous reply was malformed or missing ids; return valid '
                   'JSON covering EVERY id.')
    payload = json.dumps({'segments': items}, ensure_ascii=False)
    return [{'role': 'system', 'content': system},
            {'role': 'user', 'content': payload}]


def _parse_segments_reply(text: str) -> dict:
    """Parse a {"segments":[{"id","t"}]} (or bare array) reply -> {str(id): t}."""
    import json
    s = (text or '').strip()
    if s.startswith('```'):
        s = s.strip('`')
        s = s.split('\n', 1)[1] if '\n' in s else s
    obj = None
    try:
        obj = json.loads(s)
    except Exception:
        for op, cl in (('{', '}'), ('[', ']')):     # salvage a wrapped object/array
            a, b = s.find(op), s.rfind(cl)
            if a != -1 and b > a:
                try:
                    obj = json.loads(s[a:b + 1])
                    break
                except Exception:
                    obj = None
    rows = obj.get('segments') if isinstance(obj, dict) else obj
    out = {}
    if isinstance(rows, list):
        for r in rows:
            if isinstance(r, dict) and 'id' in r:
                tv = r.get('t', r.get('text', ''))
                # A null translation must not become the literal string "None"
                # (which would paint "None" over the page); leave it blank so the
                # caller keeps the original-text fallback.
                out[str(r['id'])] = '' if tv is None else str(tv)
    return out


def _segment_call(cfg, items, target, src, register, repair=False) -> dict:
    """One LLM round for a list of {id,text}. Returns {orig_id: translation} for
    whatever ids came back parseable (possibly a subset)."""
    by_str = {str(it['id']): it['id'] for it in items}
    try:
        reply = chat(cfg, _segment_messages(items, target, src, register, repair),
                     timeout=120)
    except Exception as e:
        logger.warning('translate_segments call failed: %s', e)
        return {}
    out = {}
    for k, t in _parse_segments_reply(reply).items():
        orig = by_str.get(k)
        if orig is not None:
            out[orig] = t
    return out


_MAX_PER_ITEM_FALLBACK = 25   # cap the last-resort per-segment retry fan-out


def translate_segments(cfg: dict, segments: list, target: str = 'English',
                       src: str = 'auto', register: str = 'neutral') -> dict:
    """Context-aware translation of many on-page segments in ONE call.

    `segments` is a list of {'id': <hashable>, 'text': <str>}. The whole batch is
    sent together (keyed by id) so the model has the full page as context and can
    translate idiomatically — not word-by-word — while the ids map results back
    1:1 even when sentence order/count diverge (EN<->AR reorders constituents).

    Returns {id: translated_text} covering EVERY input id. A segment the model
    drops, blanks, or refuses falls back to its ORIGINAL text, so the caller never
    gets an empty box. Robust to id reordering, missing ids (one batched repair
    retry, then per-item), malformed JSON and refusals."""
    result = {}
    pending = []
    for s in segments:
        text = str(s.get('text', ''))
        result[s['id']] = text                  # default: original (blanks stay blank)
        if text.strip():
            pending.append({'id': s['id'], 'text': text})
    if not pending:
        return result

    got = _segment_call(cfg, pending, target, src, register)
    missing = [p for p in pending if p['id'] not in got]
    if missing:                                 # one batched repair retry
        got.update(_segment_call(cfg, missing, target, src, register, repair=True))
    still = [p for p in pending if p['id'] not in got]
    # Bound the per-item fan-out: if a large batch is still unresolved after the
    # repair retry the model is effectively failing, so retrying hundreds of items
    # one-by-one (each a separate timeout) only amplifies cost/latency. The rest
    # keep their original-text fallback.
    for p in still[:_MAX_PER_ITEM_FALLBACK]:    # last resort: per-item (weak models)
        try:
            t = translate(cfg, p['text'], target)
            if t.strip() and not _looks_like_refusal(t):
                got[p['id']] = t
        except Exception:
            pass

    for sid, t in got.items():
        if (t or '').strip():
            result[sid] = t                     # else keep the original fallback
    return result


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
        box = it.get('box')
        try:
            if isinstance(box, (list, tuple)) and len(box) >= 4:
                b = {'x': float(box[0]), 'y': float(box[1]),    # models often emit [x,y,w,h]
                     'w': float(box[2]), 'h': float(box[3])}
            elif isinstance(box, dict):
                b = {'x': float(box.get('x', 0)), 'y': float(box.get('y', 0)),
                     'w': float(box.get('w', 0.25)), 'h': float(box.get('h', 0.07))}
            else:
                raise ValueError
            if not all(math.isfinite(v) for v in b.values()):   # reject NaN/inf -> 'NaN%' CSS
                raise ValueError
        except (TypeError, ValueError, AttributeError):
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


def detect_lang(text: str) -> str:
    """Cheap script-based source-language guess — NO LLM call. Returns 'Arabic' if
    the text is substantially Arabic-script, else 'English'. Enough to drive the
    EN<->AR default direction (one "Translate" button works both ways); the user
    can always override the source/target in the UI."""
    arabic = letters = 0
    for ch in (text or ''):
        # Count LETTERS only — Arabic-Indic digits (٠-٩) live in the Arabic block
        # but are not letters; counting them inflated the ratio and mis-flagged
        # English text like "Page ١٢٣" as Arabic.
        if not ch.isalpha():
            continue
        letters += 1
        o = ord(ch)
        if (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F      # Arabic + Supplement
                or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF):  # Presentation Forms A/B
            arabic += 1
    if letters and arabic / letters > 0.25:
        return 'Arabic'
    return 'English'
