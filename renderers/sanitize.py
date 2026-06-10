"""HTML sanitization for untrusted document content rendered into the WebView DOM.

Markdown and docx (mammoth) output is inserted into the page via ``innerHTML``, so
any raw HTML or hostile hyperlink embedded in an opened file would otherwise run
in the app's privileged pywebview origin (which carries the per-session API token
and can reach the local file endpoints). ``sanitize_html`` runs an allowlist pass
(nh3 / the Rust *ammonia* engine, which is mXSS-resistant) that:

  * keeps document formatting AND the app's own structural markup — heading ``id``
    anchors used by the outline/TOC, footnote ``data-fn-id`` markers, table spans,
    and the base64 ``data:`` images mammoth inlines for docx pictures;
  * strips ``<script>``/``<svg>``/``<iframe>`` and friends, every ``on*`` event
    handler, inline ``style`` (CSS injection), and ``javascript:``/``data:``
    *navigations* (``data:`` survives only on ``<img src>``).

If nh3 is somehow unavailable (e.g. a packaging miss in a frozen build) it FAILS
CLOSED — the markup is fully escaped to text rather than passed through raw, so a
missing dependency degrades to ugly-but-safe instead of an XSS hole.

Do NOT feed the pptx/xlsx renderers' output through this: those build trusted HTML
that relies on inline ``style`` for slide/cell layout and already escape all text.
"""

import html as _html
import logging

logger = logging.getLogger('yancoread.sanitize')

try:
    import nh3
    _HAVE_NH3 = True
except Exception:  # pragma: no cover - exercised only on a broken/partial install
    nh3 = None
    _HAVE_NH3 = False
    logging.getLogger('yancoread.sanitize').error(
        "nh3 not installed — document HTML will be escaped (fail-closed). "
        "Install nh3 to restore rich markdown/docx rendering.")

# Tags the markdown ('fenced_code','tables','toc','sane_lists','nl2br') and
# docx-Final (mammoth + footnote/heading transforms) renderers legitimately emit.
# Deliberately excludes script, style, svg, math, iframe, object, embed, form and
# every other scripting/embedding vector.
_TAGS = {
    'a', 'abbr', 'article', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
    'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
    'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
    'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
    'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
}

# Per-tag attribute allowlist. ``*`` applies to every tag. Only the two
# renderer-emitted data-* attributes are allowed — NOT a blanket data-* prefix,
# because the frontend translation tool restores ``data-tx-orig`` via innerHTML,
# so permitting arbitrary data-* from a document would reopen the XSS.
_ATTRS = {
    '*': {'class', 'id', 'dir', 'title', 'lang', 'contenteditable',
          'data-fn-id', 'data-doc-footnotes'},
    'a': {'href', 'name', 'target'},
    'img': {'src', 'alt', 'width', 'height'},
    'td': {'colspan', 'rowspan', 'headers', 'align'},
    'th': {'colspan', 'rowspan', 'scope', 'headers', 'align'},
    'ol': {'start', 'type', 'reversed'},
    'li': {'value'},
    'col': {'span'},
    'colgroup': {'span'},
}

# ``data:`` is allowed here so mammoth's inlined docx images survive — but the
# attribute filter below confines it to <img src>, so it can never be a link.
_URL_SCHEMES = {'http', 'https', 'mailto', 'tel', 'data'}

_URL_ATTRS = {'href', 'src', 'xlink:href', 'action', 'background', 'formaction',
              'poster', 'data', 'cite'}


def _attr_filter(tag, attr, value):
    """Drop ``data:`` URIs on anything navigable; keep them only for <img src>."""
    if attr in _URL_ATTRS:
        low = value.strip().lower()
        if low.startswith('data:'):
            if tag == 'img' and attr == 'src' and low.startswith('data:image/'):
                return value
            return None
    return value


def sanitize_html(markup: str) -> str:
    """Return ``markup`` with scripts/handlers/hostile URLs removed.

    Safe to call on already-clean HTML (idempotent). Empty/None input is returned
    as an empty string.
    """
    if not markup:
        return ''
    if not _HAVE_NH3:
        return _html.escape(markup)
    return nh3.clean(
        markup,
        tags=_TAGS,
        attributes=_ATTRS,
        url_schemes=_URL_SCHEMES,
        attribute_filter=_attr_filter,
        strip_comments=True,
    )
