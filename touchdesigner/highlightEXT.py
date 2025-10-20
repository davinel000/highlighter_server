"""TouchDesigner utility extension for the highlight server.

Usage inside TouchDesigner:

    op('base_highlight').ExtendDAT('touchdesigner/highlightEXT.py')
    op('base_highlight').par.Baseurl = 'http://192.168.0.9:9988'

Then from DAT execute DAT:

    op('base_highlight').FetchPhrases(op('phrases_table'))

All methods accept either a DAT operator or operator path for the output
table. Table columns are always replaced with fresh data.
"""

import json
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional
from urllib import request as _urlreq


class HighlightEXT:
    """Extension entry point used by TouchDesigner."""

    def __init__(self, ownerComp):  # type: ignore[no-untyped-def]
        self.ownerComp = ownerComp
        self.base_url = "http://127.0.0.1:9888"
        self.webclient = None
        self._form_cursor: Dict[str, int] = {}
        self._button_cache: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # configuration helpers
    # ------------------------------------------------------------------
    def SetWebClient(self, dat, base_url: Optional[str] = None):  # type: ignore[no-untyped-def]
        """Assign a Web Client DAT and optional base URL."""

        self.webclient = dat
        if base_url:
            self.base_url = base_url.rstrip("/")
        return self.webclient

    def SetBaseUrl(self, url: str):
        self.base_url = url.rstrip("/")

    # ------------------------------------------------------------------
    # public fetchers
    # ------------------------------------------------------------------
    def FetchPhrases(  # type: ignore[no-untyped-def]
        self,
        target,
        doc: str = "doc1",
        min_count: int = 1,
        color_filter: Optional[str] = None,
    ) -> None:
        """Populate *target* table with phrases aggregate."""

        payload = self._request_json("/api/phrases", params={"doc": doc})
        phrases = payload.get("phrases", []) if isinstance(payload, dict) else []
        rows = []
        for item in phrases:
            count = int(item.get("count", 0))
            if count < min_count:
                continue
            color = item.get("color") or ""
            if color_filter and color != color_filter:
                continue
            rows.append(
                [
                    item.get("text", ""),
                    color,
                    count,
                    ", ".join(item.get("clients", [])),
                ]
            )
        self._write_table(target, ["text", "color", "count", "clients"], rows)

    def FetchFormResults(  # type: ignore[no-untyped-def]
        self,
        target,
        form: str = "feedback",
        incremental: bool = True,
    ) -> None:
        """Populate *target* with feedback responses."""

        params: Dict[str, Any] = {"form": form}
        if incremental:
            since = self._form_cursor.get(form)
            if since:
                params["since"] = since
        payload = self._request_json("/api/forms/results", params=params)
        results = payload.get("results", []) if isinstance(payload, dict) else []
        if incremental and results:
            last_seq = max(int(r.get("seq", 0)) for r in results)
            if last_seq:
                self._form_cursor[form] = last_seq
        rows = []
        for item in results:
            ts = item.get("submitted")
            iso = self._iso_from_timestamp(ts)
            rows.append(
                [
                    int(item.get("seq", 0)),
                    item.get("clientId", ""),
                    item.get("question", ""),
                    item.get("answer", ""),
                    ts,
                    iso,
                ]
            )
        headers = ["seq", "clientId", "question", "answer", "submitted", "submitted_iso"]
        self._write_table(target, headers, rows)

    def FetchButtonEvents(  # type: ignore[no-untyped-def]
        self,
        target,
        panel: str = "main",
        max_events: int = 128,
        incremental: bool = True,
    ) -> None:
        """Populate *target* with button press events and counts."""

        cache = self._button_cache.setdefault(panel, {"nextSeq": 0, "events": []})
        params: Dict[str, Any] = {"panel": panel}
        if incremental and cache.get("nextSeq"):
            params["since"] = cache["nextSeq"] - 1
        payload = self._request_json("/api/triggers/state", params=params)
        if not isinstance(payload, dict):
            return
        events = payload.get("events", []) or []
        if events:
            cache["events"].extend(events)
            cache["events"] = cache["events"][-max_events:]
        cache["nextSeq"] = payload.get("nextSeq", cache.get("nextSeq", 0))
        rows = []
        for item in cache["events"]:
            ts = item.get("timestamp")
            rows.append(
                [
                    int(item.get("seq", 0)),
                    item.get("buttonId", ""),
                    item.get("label", ""),
                    item.get("direction", ""),
                    item.get("clientId", ""),
                    ts,
                    self._iso_from_timestamp(ts),
                ]
            )
        headers = ["seq", "buttonId", "label", "direction", "clientId", "timestamp", "timestamp_iso"]
        self._write_table(target, headers, rows)

    # ------------------------------------------------------------------
    # internal helpers
    # ------------------------------------------------------------------
    def _request_json(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Synchronous HTTP GET that returns parsed JSON. Does not rely on Web Client DAT."""
        url = self._build_url(endpoint, params)
        try:
            with _urlreq.urlopen(url, timeout=5) as resp:
                raw = resp.read()
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8", errors="ignore")
            if not raw:
                return {}
            return json.loads(raw)
        except Exception as e:
            # Лаконичный лог + пустой результат, чтобы не ронять цикл
            debug = getattr(self, "debug", True)
            if debug:
                print("[highlightEXT] _request_json error:", e, "URL:", url)
            return {}

    def _build_url(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> str:
        endpoint = endpoint or "/"
        if not endpoint.startswith("/"):
            endpoint = "/" + endpoint
        url = f"{self.base_url}{endpoint}"
        if params:
            pairs = []
            for key, value in params.items():
                if value is None:
                    continue
                if isinstance(value, (list, tuple)):
                    for item in value:
                        pairs.append(f"{key}={item}")
                else:
                    pairs.append(f"{key}={value}")
            if pairs:
                url += "?" + "&".join(pairs)
        return url

    def _write_table(self, target, headers: Iterable[str], rows: Iterable[Iterable[Any]]) -> None:
        dat = self._resolve_dat(target)
        if dat is None:
            raise ValueError("Target DAT not found")
        dat.clear()
        dat.appendRow(list(headers))
        for row in rows:
            dat.appendRow(["" if v is None else v for v in row])

    def _resolve_dat(self, target):  # type: ignore[no-untyped-def]
        if target is None:
            return None
        if hasattr(target, "appendRow"):
            return target
        return self.ownerComp.op(target)

    def _iso_from_timestamp(self, value: Any) -> str:
        try:
            ts = float(value)
        except (TypeError, ValueError):
            return ""
        return datetime.fromtimestamp(ts).isoformat(sep=" ", timespec="seconds")
