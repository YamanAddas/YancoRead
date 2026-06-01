"""
YancoRead — image metadata (Pillow).

Pulls everything the Image viewer's Info panel shows: pixel dimensions, colour
mode, format, file size, DPI, frame count (animated GIF/WEBP), alpha, and a
curated, human-readable EXIF block (camera, lens, exposure, aperture, ISO,
focal length, date taken, orientation…) plus decoded GPS coordinates.

Everything is defensive: a corrupt or EXIF-less image still returns the basic
block; only the fields that genuinely exist are included.
"""

import os

from PIL import ExifTags, Image

_EXIF_TAGS = ExifTags.TAGS
_GPS_TAGS = ExifTags.GPSTAGS

# Pillow ≥ 8 exposes the sub-IFD ids via ExifTags.IFD; fall back to raw ids.
try:
    _IFD_EXIF = ExifTags.IFD.Exif
    _IFD_GPS = ExifTags.IFD.GPSInfo
except Exception:  # pragma: no cover - very old Pillow
    _IFD_EXIF, _IFD_GPS = 0x8769, 0x8825

try:
    _RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # pragma: no cover - very old Pillow
    _RESAMPLE = Image.LANCZOS

_ORIENTATION = {
    1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored, 180°',
    5: 'Mirrored, 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, 90° CW',
    8: 'Rotated 90° CCW',
}
_METERING = {
    0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot',
    4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other',
}
_WHITE_BALANCE = {0: 'Auto', 1: 'Manual'}


def _human_size(n: int) -> str:
    f = float(n)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if f < 1024 or unit == 'GB':
            return f'{int(f)} {unit}' if unit == 'B' else f'{f:.1f} {unit}'
        f /= 1024
    return f'{f:.1f} GB'


def _clean(v):
    if isinstance(v, bytes):
        try:
            v = v.decode('utf-8', 'replace')
        except Exception:
            v = str(v)
    if isinstance(v, str):
        v = v.replace('\x00', '').strip()
    return v


def _num(v):
    """IFDRational / tuple → float, defensively."""
    try:
        if isinstance(v, (tuple, list)) and len(v) == 2:
            return v[0] / v[1] if v[1] else None
        return float(v)
    except Exception:
        return None


def _fmt_exposure(v):
    f = _num(v)
    if not f or f <= 0:
        return None
    return f'{f:g} s' if f >= 1 else f'1/{round(1 / f)} s'


def _fmt_fnumber(v):
    f = _num(v)
    return f'f/{f:g}' if f else None


def _fmt_focal(v):
    f = _num(v)
    return f'{f:g} mm' if f else None


def _fmt_iso(v):
    if isinstance(v, (tuple, list)) and v:
        v = v[0]
    try:
        return f'ISO {int(v)}'
    except Exception:
        return None


def _fmt_ev(v):
    f = _num(v)
    return None if f is None else f'{f:+g} EV'


def _fmt_datetime(v):
    v = _clean(v)
    if isinstance(v, str) and len(v) >= 10 and v[4] == ':' and v[7] == ':':
        date, _, time = v.partition(' ')
        return date.replace(':', '-') + (' ' + time if time else '')
    return v or None


def _fmt_flash(v):
    try:
        return 'Fired' if (int(v) & 1) else 'Did not fire'
    except Exception:
        return None


def _lookup(table):
    def f(v):
        try:
            return table.get(int(v))
        except Exception:
            return None
    return f


# (exif tag name, display label, formatter). First non-empty value per label wins.
_CURATED = [
    ('Make', 'Camera make', _clean),
    ('Model', 'Camera model', _clean),
    ('LensModel', 'Lens', _clean),
    ('DateTimeOriginal', 'Date taken', _fmt_datetime),
    ('DateTime', 'Date taken', _fmt_datetime),
    ('ExposureTime', 'Exposure', _fmt_exposure),
    ('FNumber', 'Aperture', _fmt_fnumber),
    ('ISOSpeedRatings', 'ISO', _fmt_iso),
    ('PhotographicSensitivity', 'ISO', _fmt_iso),
    ('FocalLength', 'Focal length', _fmt_focal),
    ('FocalLengthIn35mmFilm', 'Focal length (35mm eq.)', _fmt_focal),
    ('ExposureBiasValue', 'Exposure bias', _fmt_ev),
    ('MeteringMode', 'Metering', _lookup(_METERING)),
    ('Flash', 'Flash', _fmt_flash),
    ('WhiteBalance', 'White balance', _lookup(_WHITE_BALANCE)),
    ('Orientation', 'Orientation', _lookup(_ORIENTATION)),
    ('Software', 'Software', _clean),
    ('Artist', 'Artist', _clean),
    ('Copyright', 'Copyright', _clean),
]


def _dms_to_deg(dms, ref):
    try:
        d, m, s = (_num(x) or 0 for x in dms)
        deg = d + m / 60.0 + s / 3600.0
        if str(ref).upper() in ('S', 'W'):
            deg = -deg
        return round(deg, 6)
    except Exception:
        return None


def _extract_exif(img):
    """Return (exif_pairs, gps_dict_or_None)."""
    try:
        raw = img.getexif()
    except Exception:
        return [], None
    if not raw:
        return [], None

    merged = {}
    for k, v in raw.items():
        merged[_EXIF_TAGS.get(k, k)] = v
    try:
        for k, v in raw.get_ifd(_IFD_EXIF).items():
            merged[_EXIF_TAGS.get(k, k)] = v
    except Exception:
        pass

    pairs, seen = [], set()
    for tag, label, fmt in _CURATED:
        if label in seen or tag not in merged:
            continue
        try:
            val = fmt(merged[tag])
        except Exception:
            val = None
        if val not in (None, ''):
            pairs.append([label, str(val)])
            seen.add(label)

    gps = None
    try:
        g = {_GPS_TAGS.get(k, k): v for k, v in raw.get_ifd(_IFD_GPS).items()}
        lat = _dms_to_deg(g.get('GPSLatitude'), g.get('GPSLatitudeRef'))
        lon = _dms_to_deg(g.get('GPSLongitude'), g.get('GPSLongitudeRef'))
        if lat is not None and lon is not None:
            gps = {'lat': lat, 'lon': lon, 'text': f'{lat:.6f}, {lon:.6f}'}
    except Exception:
        gps = None

    return pairs, gps


def info(path: str) -> dict:
    """Full metadata block for one image file."""
    try:
        size_bytes = os.path.getsize(path)
    except OSError:
        size_bytes = 0

    out = {
        'name': os.path.basename(path),
        'size_bytes': size_bytes,
        'size_human': _human_size(size_bytes),
        'format': None, 'mode': None, 'width': 0, 'height': 0,
        'megapixels': None, 'dpi': None, 'frames': 1, 'has_alpha': False,
        'exif': [], 'gps': None,
    }

    with Image.open(path) as img:
        out['format'] = img.format
        out['mode'] = img.mode
        out['width'], out['height'] = img.width, img.height
        if img.width and img.height:
            out['megapixels'] = round((img.width * img.height) / 1_000_000, 1)
        out['has_alpha'] = img.mode in ('RGBA', 'LA', 'PA') or 'transparency' in img.info
        out['frames'] = int(getattr(img, 'n_frames', 1) or 1)
        dpi = img.info.get('dpi')
        if dpi and dpi[0]:
            try:
                out['dpi'] = f'{round(float(dpi[0]))} × {round(float(dpi[1]))}'
            except Exception:
                pass
        out['exif'], out['gps'] = _extract_exif(img)

    return out


def thumbnail_png(path: str, max_dim: int = 1600) -> bytes:
    """A bounded, normalised PNG copy of an image — the payload we hand to a
    vision model. Flattens animation to the first frame, composites any
    transparency over white, converts to RGB and caps the longest side at
    *max_dim* so even a 50-megapixel original stays a reasonable upload."""
    import io

    with Image.open(path) as img:
        try:
            img.seek(0)  # first frame for animated GIF/WEBP/APNG
        except Exception:
            pass
        if img.mode in ('RGBA', 'LA', 'PA') or 'transparency' in img.info:
            img = img.convert('RGBA')
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim), _RESAMPLE)
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        return buf.getvalue()
