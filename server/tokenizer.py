"""
Tokenization utilities shared by the highlight server.

The logic mirrors the behaviour of the original TouchDesigner callbacks so
that existing front-end code can rely on stable token indices.
"""
from __future__ import annotations

import html
import re
from typing import Iterable, List

RE_SPLIT = re.compile(r'([\s]+|[.,:;!?()"\-\'\[\]{}«»“”—–…])')
PUNCT_BREAK = set(list('.,:;!?()"\'-[]{}«»“”—–…'))

HTML_CLOSE_TO_NL = re.compile(r'(?i)</(p|h1|h2|h3|h4|h5|h6|li|div|section|article|blockquote)>\s*')
HTML_BR = re.compile(r'(?i)<br\s*/?>')
HTML_TAGS = re.compile(r'(?is)<[^>]+>')
MULTI_NL = re.compile(r'\n{3,}')


def html_to_plain(text: str) -> str:
    """Convert HTML content to plain text while preserving structural breaks."""
    if '<' not in text or '>' not in text:
        return html.unescape(text)
    text = HTML_BR.sub('\n', text)
    text = HTML_CLOSE_TO_NL.sub('\n', text)
    text = HTML_TAGS.sub('', text)
    text = html.unescape(text)
    text = MULTI_NL.sub('\n\n', text)
    return text


def tokenize(text: str) -> List[str]:
    """
    Split text into tokens using the canonical regex. Whitespace tokens are
    dropped except for newlines, which are emitted as explicit "\n" tokens.
    """
    plain = html_to_plain(text)
    raw = [seg for seg in RE_SPLIT.split(plain) if seg]
    tokens: List[str] = []
    for seg in raw:
        if seg.isspace():
            newlines = seg.count('\n')
            tokens.extend('\n' for _ in range(newlines))
            continue
        tokens.append(seg)
    return tokens


def is_break_token(token: str) -> bool:
    """Return True if the token breaks highlight ranges (punctuation or newline)."""
    if token in ('\n', '\r', '\r\n'):
        return True
    if not token:
        return False
    return all(char in PUNCT_BREAK for char in token)


def normalised_text(tokens: Iterable[str]) -> str:
    """Join tokens into lowercase text for phrase aggregation."""
    return ' '.join(tokens).strip().lower()


__all__ = [
    "tokenize",
    "is_break_token",
]
