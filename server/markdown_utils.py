from __future__ import annotations

import markdown


def markdown_to_html(source: str) -> str:
    """
    Convert Markdown text into HTML using a minimal markdown configuration.
    Headings, lists, emphasis, and horizontal rules are supported by default.
    """
    md = markdown.Markdown(extensions=["extra", "sane_lists"])
    html = md.convert(source)
    md.reset()
    return html


__all__ = ["markdown_to_html"]
