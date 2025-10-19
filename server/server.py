from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Allow running `python server/server.py` without installing as a package.
SERVER_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.append(str(SERVER_DIR))

from tokenizer import is_break_token, tokenize  # noqa: E402
from markdown_utils import markdown_to_html  # noqa: E402


LOGGER = logging.getLogger("highlight.server")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

BASE_DIR = Path(__file__).resolve().parents[1]
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
WWWDOCS_DIR = BASE_DIR / "wwwdocs"

DEFAULT_DOC_ID = "doc1"
DEFAULT_SOURCE_NAME = "text.txt"
DOC_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
FORM_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
PANEL_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

DEFAULT_FORM_ID = "feedback"
DEFAULT_FORM_QUESTION = "Share your thoughts with us."
MAX_FORM_ANSWER_LENGTH = 1024
MAX_FORM_RESPONSES = 2000

DEFAULT_BUTTON_PANEL = "main"
BUTTON_DEFINITIONS = [
    {"id": "suspension", "label": "Suspension"},
    {"id": "extension", "label": "Extension"},
    {"id": "reversal", "label": "Reversal"},
    {"id": "speed", "label": "Speed"},
]
DEFAULT_BUTTON_SEQUENCE = [item["id"] for item in BUTTON_DEFINITIONS]
MAX_BUTTON_EVENTS = 1000

DATA_DIR.mkdir(parents=True, exist_ok=True)
WWWDOCS_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class DocState:
    tokens: List[str] = field(default_factory=list)
    votes: List[Dict[str, str]] = field(default_factory=list)
    updated: Optional[float] = None
    source_name: str = DEFAULT_SOURCE_NAME


class DocumentStore:
    def __init__(self) -> None:
        self._states: Dict[str, DocState] = {}
        self._locks: Dict[str, asyncio.Lock] = {}
        self._ws_connections: Dict[str, Set[WebSocket]] = {}
        self._lock_flags: Dict[str, bool] = {}

    def _state_path(self, doc_id: str) -> Path:
        return DATA_DIR / f"state_{doc_id}.json"

    def _jsonl_path(self, doc_id: str) -> Path:
        return DATA_DIR / f"state_{doc_id}.jsonl"

    def _doc_lock(self, doc_id: str) -> asyncio.Lock:
        lock = self._locks.get(doc_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[doc_id] = lock
        return lock

    async def get_state(self, doc_id: str) -> DocState:
        state = self._states.get(doc_id)
        if state is None:
            state = self._load_state_from_disk(doc_id)
            self._states[doc_id] = state
        return state

    def _load_state_from_disk(self, doc_id: str) -> DocState:
        path = self._state_path(doc_id)
        if not path.exists():
            return DocState()
        try:
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except Exception as exc:
            LOGGER.error("Failed to load state for %s: %s", doc_id, exc)
            return DocState()
        tokens = list(raw.get("tokens") or [])
        votes = [dict(entry) for entry in (raw.get("votes") or [])]
        updated = raw.get("updated")
        source_name_raw = raw.get("sourceName")
        source_name = self._sanitize_source_name(source_name_raw) if source_name_raw else DEFAULT_SOURCE_NAME
        state = DocState(tokens=tokens, votes=votes, updated=updated, source_name=source_name)
        self._ensure_votes_length(state)
        return state

    async def save_state(self, doc_id: str, state: DocState) -> None:
        self._ensure_votes_length(state)
        payload = {
            "tokens": state.tokens,
            "votes": state.votes,
            "updated": state.updated,
            "sourceName": state.source_name,
        }
        path = self._state_path(doc_id)
        tmp_file = None
        try:
            with NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=DATA_DIR) as tmp:
                json.dump(payload, tmp, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_file = Path(tmp.name)
            os.replace(tmp_file, path)
        finally:
            if tmp_file and tmp_file.exists():
                tmp_file.unlink(missing_ok=True)
        self._states[doc_id] = state

    async def ensure_tokens(self, doc_id: str, source_name: Optional[str]) -> DocState:
        async with self._doc_lock(doc_id):
            return await self._ensure_tokens_locked(doc_id, source_name)

    async def _ensure_tokens_locked(self, doc_id: str, source_name: Optional[str]) -> DocState:
        state = await self.get_state(doc_id)
        if state.tokens:
            return state
        resolved_name = self._resolve_source_name(state, source_name)
        tokens, resolved = self._tokenize_from_source(resolved_name)
        state.tokens = tokens
        state.source_name = resolved
        state.updated = state.updated or time.time()
        self._ensure_votes_length(state)
        await self.save_state(doc_id, state)
        return state

    async def retokenize(self, doc_id: str, source_name: Optional[str]) -> DocState:
        resolved_name = self._sanitize_source_name(source_name) if source_name else DEFAULT_SOURCE_NAME
        tokens, resolved = self._tokenize_from_source(resolved_name)
        async with self._doc_lock(doc_id):
            state = await self.get_state(doc_id)
            state.tokens = tokens
            state.votes = [dict() for _ in range(len(tokens))]
            state.updated = time.time()
            state.source_name = resolved
            await self.save_state(doc_id, state)
            return state

    async def clear_votes(self, doc_id: str) -> DocState:
        async with self._doc_lock(doc_id):
            state = await self._ensure_tokens_locked(doc_id, None)
            state.votes = [dict() for _ in range(len(state.tokens))]
            state.updated = time.time()
            await self.save_state(doc_id, state)
            return state

    async def apply_highlight(
        self,
        doc_id: str,
        client_id: str,
        start: int,
        end: int,
        color: str,
        timestamp: Optional[float],
    ) -> bool:
        if self.is_locked(doc_id):
            return False
        async with self._doc_lock(doc_id):
            state = await self._ensure_tokens_locked(doc_id, None)
            if not state.tokens:
                return False
            n = len(state.tokens)
            start = max(0, min(start, n - 1))
            end = max(0, min(end, n - 1))
            if start > end:
                start, end = end, start
            self._ensure_votes_length(state)
            changed = False
            for idx in range(start, end + 1):
                bucket = state.votes[idx]
                if color:
                    if bucket.get(client_id) != color:
                        bucket[client_id] = color
                        changed = True
                else:
                    if bucket.pop(client_id, None) is not None:
                        changed = True
            if changed:
                state.updated = timestamp or time.time()
                await self.save_state(doc_id, state)
            return changed

    async def clear_client(self, doc_id: str, client_id: str, timestamp: Optional[float]) -> bool:
        if self.is_locked(doc_id):
            return False
        async with self._doc_lock(doc_id):
            state = await self._ensure_tokens_locked(doc_id, None)
            changed = False
            for bucket in state.votes:
                if bucket.pop(client_id, None) is not None:
                    changed = True
            if changed:
                state.updated = timestamp or time.time()
                await self.save_state(doc_id, state)
            return changed

    def set_locked(self, doc_id: str, value: bool) -> None:
        self._lock_flags[doc_id] = value

    def is_locked(self, doc_id: str) -> bool:
        return bool(self._lock_flags.get(doc_id, False))

    def register_ws(self, doc_id: str, websocket: WebSocket) -> None:
        self._ws_connections.setdefault(doc_id, set()).add(websocket)

    def unregister_ws(self, doc_id: str, websocket: WebSocket) -> None:
        conns = self._ws_connections.get(doc_id)
        if not conns:
            return
        conns.discard(websocket)
        if not conns:
            self._ws_connections.pop(doc_id, None)

    async def broadcast(self, doc_id: str, message: Dict) -> None:
        if doc_id not in self._ws_connections:
            return
        payload = json.dumps(message, ensure_ascii=False)
        dead: List[WebSocket] = []
        for ws in list(self._ws_connections[doc_id]):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unregister_ws(doc_id, ws)

    def _tokenize_from_source(self, source_name: str) -> tuple[List[str], str]:
        text = _strip_bom(self.read_source_text(source_name))
        is_md = is_markdown_name(source_name)
        html_like = is_md or source_name.lower().endswith(".html")
        if is_md:
            rendered = markdown_to_html(text)
            rendered = _strip_bom(rendered)
            tokens = tokenize(rendered)
        else:
            tokens = tokenize(text)
        if html_like:
            tokens = [tok for tok in tokens if tok and tok != "\n"]
        return tokens, source_name

    def _resolve_source_name(self, state: DocState, override: Optional[str]) -> str:
        if override:
            return self._sanitize_source_name(override)
        if state.source_name:
            return self._sanitize_source_name(state.source_name)
        return DEFAULT_SOURCE_NAME

    def read_source_text(self, source_name: Optional[str]) -> str:
        name = self._sanitize_source_name(source_name) or DEFAULT_SOURCE_NAME
        path = WWWDOCS_DIR / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail=f"Source '{name}' not found")
        try:
            return _strip_bom(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            return _strip_bom(path.read_text(encoding="utf-8", errors="ignore"))

    def _sanitize_source_name(self, name: Optional[str]) -> str:
        if not name:
            return DEFAULT_SOURCE_NAME
        return Path(name).name

    def _ensure_votes_length(self, state: DocState) -> None:
        target = len(state.tokens)
        votes = state.votes
        if len(votes) < target:
            votes.extend({} for _ in range(target - len(votes)))
        elif len(votes) > target:
            del votes[target:]

    def list_document_ids(self) -> List[str]:
        doc_ids = set(self._states.keys())
        doc_ids.add(DEFAULT_DOC_ID)
        for path in DATA_DIR.glob("state_*.json"):
            stem = path.stem
            if stem.startswith("state_"):
                doc_ids.add(stem[6:])
        return sorted(doc_ids)


store = DocumentStore()


@dataclass
class FormState:
    form_id: str
    question: str = DEFAULT_FORM_QUESTION
    cooldown: float = 0.0
    allow_repeat: bool = True
    locked: bool = False
    responses: List[Dict[str, Any]] = field(default_factory=list)
    last_by_client: Dict[str, float] = field(default_factory=dict)
    next_seq: int = 1
    updated: Optional[float] = None


class FormError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, payload: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.payload = payload or {}


class FormManager:
    def __init__(self) -> None:
        self._states: Dict[str, FormState] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    def _path(self, form_id: str) -> Path:
        return DATA_DIR / f"form_{form_id}.json"

    def _lock(self, form_id: str) -> asyncio.Lock:
        lock = self._locks.get(form_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[form_id] = lock
        return lock

    def _default_state(self, form_id: str) -> FormState:
        state = FormState(form_id=form_id)
        state.question = DEFAULT_FORM_QUESTION
        return state

    def _ensure_loaded(self, form_id: str) -> FormState:
        state = self._states.get(form_id)
        if state is None:
            state = self._load_state(form_id)
            self._states[form_id] = state
        return state

    def _load_state(self, form_id: str) -> FormState:
        path = self._path(form_id)
        if not path.exists():
            return self._default_state(form_id)
        try:
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except Exception as exc:
            LOGGER.error("Failed to load form %s: %s", form_id, exc)
            return self._default_state(form_id)
        state = self._default_state(form_id)
        state.question = (raw.get("question") or DEFAULT_FORM_QUESTION).strip() or DEFAULT_FORM_QUESTION
        state.cooldown = float(raw.get("cooldown") or 0.0)
        state.allow_repeat = bool(raw.get("allowRepeat", True))
        state.locked = bool(raw.get("locked", False))
        responses = raw.get("responses") or []
        state.responses = [dict(item) for item in responses]
        for idx, item in enumerate(state.responses, start=1):
            item.setdefault("seq", idx)
        state.next_seq = int(raw.get("nextSeq") or (len(state.responses) + 1))
        state.last_by_client = {k: float(v) for k, v in (raw.get("lastByClient") or {}).items()}
        state.updated = raw.get("updated")
        return state

    async def _save_state(self, form_id: str, state: FormState) -> None:
        payload = {
            "formId": form_id,
            "question": state.question,
            "cooldown": state.cooldown,
            "allowRepeat": state.allow_repeat,
            "locked": state.locked,
            "responses": state.responses,
            "lastByClient": state.last_by_client,
            "nextSeq": state.next_seq,
            "updated": state.updated,
        }
        path = self._path(form_id)
        tmp_file: Optional[Path] = None
        try:
            with NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=DATA_DIR) as tmp:
                json.dump(payload, tmp, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_file = Path(tmp.name)
            os.replace(tmp_file, path)
        finally:
            if tmp_file and tmp_file.exists():
                tmp_file.unlink(missing_ok=True)
        self._states[form_id] = state

    async def get_config(self, form_id: str) -> Dict[str, Any]:
        async with self._lock(form_id):
            state = self._ensure_loaded(form_id)
            return self._config_snapshot(state)

    def _config_snapshot(self, state: FormState) -> Dict[str, Any]:
        return {
            "formId": state.form_id,
            "question": state.question,
            "cooldown": state.cooldown,
            "allowRepeat": state.allow_repeat,
            "locked": state.locked,
            "nextSeq": state.next_seq,
            "responseCount": len(state.responses),
        }

    async def update_config(
        self,
        form_id: str,
        *,
        question: Optional[str] = None,
        cooldown: Optional[float] = None,
        allow_repeat: Optional[bool] = None,
        locked: Optional[bool] = None,
    ) -> Dict[str, Any]:
        async with self._lock(form_id):
            state = self._ensure_loaded(form_id)
            if question is not None:
                q = question.strip()
                if not q:
                    raise FormError("invalid_question", "Question cannot be empty")
                if len(q) > 280:
                    raise FormError("invalid_question", "Question must be 280 characters or fewer")
                state.question = q
            if cooldown is not None:
                state.cooldown = max(0.0, float(cooldown))
            if allow_repeat is not None:
                state.allow_repeat = bool(allow_repeat)
            if locked is not None:
                state.locked = bool(locked)
            state.updated = time.time()
            await self._save_state(form_id, state)
            return self._config_snapshot(state)

    async def submit(self, form_id: str, client_id: str, answer: str) -> Dict[str, Any]:
        trimmed = answer.strip()
        if not trimmed:
            raise FormError("empty_answer", "Answer cannot be empty")
        if len(trimmed) > MAX_FORM_ANSWER_LENGTH:
            trimmed = trimmed[:MAX_FORM_ANSWER_LENGTH]
        now = time.time()
        async with self._lock(form_id):
            state = self._ensure_loaded(form_id)
            if state.locked:
                raise FormError("locked", "Form is locked", status=423)
            last = state.last_by_client.get(client_id)
            if state.cooldown > 0 and last is not None:
                delta = now - last
                if delta < state.cooldown:
                    raise FormError(
                        "cooldown",
                        "Cooldown is active",
                        status=429,
                        payload={"retry_in": max(0.0, state.cooldown - delta)},
                    )
            if not state.allow_repeat:
                for item in state.responses:
                    if item.get("clientId") == client_id:
                        raise FormError("repeat_not_allowed", "Repeat submissions are disabled", status=409)
            seq = state.next_seq
            record = {
                "seq": seq,
                "clientId": client_id,
                "answer": trimmed,
                "question": state.question,
                "submitted": now,
            }
            state.responses.append(record)
            if len(state.responses) > MAX_FORM_RESPONSES:
                state.responses = state.responses[-MAX_FORM_RESPONSES:]
            state.last_by_client[client_id] = now
            state.next_seq = seq + 1
            state.updated = now
            await self._save_state(form_id, state)
            return record

    async def results(self, form_id: str, since: Optional[int] = None) -> Dict[str, Any]:
        async with self._lock(form_id):
            state = self._ensure_loaded(form_id)
            if since is None:
                items = [dict(item) for item in state.responses]
            else:
                items = [dict(item) for item in state.responses if item.get("seq", 0) > since]
            return {
                "formId": form_id,
                "results": items,
                "nextSeq": state.next_seq,
                "updated": state.updated,
                "cooldown": state.cooldown,
                "allowRepeat": state.allow_repeat,
                "locked": state.locked,
            }

    async def clear(self, form_id: str) -> Dict[str, Any]:
        async with self._lock(form_id):
            state = self._ensure_loaded(form_id)
            state.responses.clear()
            state.last_by_client.clear()
            state.next_seq = 1
            state.updated = time.time()
            await self._save_state(form_id, state)
            return self._config_snapshot(state)

    def list_form_ids(self) -> List[str]:
        form_ids = set(self._states.keys())
        form_ids.add(DEFAULT_FORM_ID)
        for path in DATA_DIR.glob("form_*.json"):
            stem = path.stem
            if stem.startswith("form_"):
                form_ids.add(stem[5:])
        return sorted(form_ids)


@dataclass
class ButtonPanelState:
    panel_id: str
    buttons: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    events: List[Dict[str, Any]] = field(default_factory=list)
    locked: bool = False
    cooldown: float = 0.0
    last_by_client: Dict[str, float] = field(default_factory=dict)
    next_seq: int = 1
    updated: Optional[float] = None


class ButtonError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, payload: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.payload = payload or {}


class ButtonManager:
    def __init__(self) -> None:
        self._states: Dict[str, ButtonPanelState] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    def _path(self, panel_id: str) -> Path:
        return DATA_DIR / f"buttons_{panel_id}.json"

    def _lock(self, panel_id: str) -> asyncio.Lock:
        lock = self._locks.get(panel_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[panel_id] = lock
        return lock

    def _default_buttons(self) -> Dict[str, Dict[str, Any]]:
        return {
            item["id"]: {"label": item["label"], "minus": 0, "plus": 0}
            for item in BUTTON_DEFINITIONS
        }

    def _default_state(self, panel_id: str) -> ButtonPanelState:
        state = ButtonPanelState(panel_id=panel_id)
        state.buttons = self._default_buttons()
        return state

    def _ensure_loaded(self, panel_id: str) -> ButtonPanelState:
        state = self._states.get(panel_id)
        if state is None:
            state = self._load_state(panel_id)
            self._states[panel_id] = state
        return state

    def _load_state(self, panel_id: str) -> ButtonPanelState:
        path = self._path(panel_id)
        if not path.exists():
            return self._default_state(panel_id)
        try:
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except Exception as exc:
            LOGGER.error("Failed to load buttons %s: %s", panel_id, exc)
            return self._default_state(panel_id)
        state = self._default_state(panel_id)
        loaded_buttons = raw.get("buttons") or {}
        for button_id, info in loaded_buttons.items():
            state.buttons.setdefault(
                button_id,
                {"label": info.get("label", button_id.title()), "minus": 0, "plus": 0},
            )
            entry = state.buttons[button_id]
            entry["label"] = info.get("label", entry["label"])
            entry["minus"] = int(info.get("minus", 0))
            entry["plus"] = int(info.get("plus", 0))
        state.locked = bool(raw.get("locked", False))
        state.cooldown = float(raw.get("cooldown") or 0.0)
        state.events = [dict(item) for item in (raw.get("events") or [])]
        for idx, item in enumerate(state.events, start=1):
            item.setdefault("seq", idx)
        state.next_seq = int(raw.get("nextSeq") or (len(state.events) + 1))
        state.last_by_client = {k: float(v) for k, v in (raw.get("lastByClient") or {}).items()}
        state.updated = raw.get("updated")
        return state

    async def _save_state(self, panel_id: str, state: ButtonPanelState) -> None:
        payload = {
            "panelId": panel_id,
            "buttons": state.buttons,
            "events": state.events,
            "locked": state.locked,
            "cooldown": state.cooldown,
            "lastByClient": state.last_by_client,
            "nextSeq": state.next_seq,
            "updated": state.updated,
        }
        path = self._path(panel_id)
        tmp_file: Optional[Path] = None
        try:
            with NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=DATA_DIR) as tmp:
                json.dump(payload, tmp, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_file = Path(tmp.name)
            os.replace(tmp_file, path)
        finally:
            if tmp_file and tmp_file.exists():
                tmp_file.unlink(missing_ok=True)
        self._states[panel_id] = state

    async def get_config(self, panel_id: str) -> Dict[str, Any]:
        async with self._lock(panel_id):
            state = self._ensure_loaded(panel_id)
            return self._config_snapshot(panel_id, state)

    def _config_snapshot(self, panel_id: str, state: ButtonPanelState) -> Dict[str, Any]:
        buttons = [
            {
                "id": button_id,
                "label": info["label"],
                "minus": info["minus"],
                "plus": info["plus"],
            }
            for button_id, info in state.buttons.items()
        ]
        order = {bid: idx for idx, bid in enumerate(DEFAULT_BUTTON_SEQUENCE)}
        buttons.sort(key=lambda item: order.get(item["id"], len(order)))
        return {
            "panelId": panel_id,
            "buttons": buttons,
            "locked": state.locked,
            "cooldown": state.cooldown,
            "nextSeq": state.next_seq,
            "eventCount": len(state.events),
        }

    async def update_config(
        self,
        panel_id: str,
        *,
        cooldown: Optional[float] = None,
        locked: Optional[bool] = None,
    ) -> Dict[str, Any]:
        async with self._lock(panel_id):
            state = self._ensure_loaded(panel_id)
            if cooldown is not None:
                state.cooldown = max(0.0, float(cooldown))
            if locked is not None:
                state.locked = bool(locked)
            state.updated = time.time()
            await self._save_state(panel_id, state)
            return self._config_snapshot(panel_id, state)

    async def fire(
        self,
        panel_id: str,
        client_id: str,
        button_id: str,
        direction: str,
    ) -> Dict[str, Any]:
        direction_norm = direction.lower()
        if direction_norm not in ("minus", "plus"):
            raise ButtonError("invalid_direction", "Direction must be 'minus' or 'plus'")
        now = time.time()
        async with self._lock(panel_id):
            state = self._ensure_loaded(panel_id)
            if state.locked:
                raise ButtonError("locked", "Panel is locked", status=423)
            info = state.buttons.get(button_id)
            if info is None:
                raise ButtonError("unknown_button", f"Button '{button_id}' is not defined", status=404)
            last = state.last_by_client.get(client_id)
            if state.cooldown > 0 and last is not None:
                delta = now - last
                if delta < state.cooldown:
                    raise ButtonError(
                        "cooldown",
                        "Cooldown is active",
                        status=429,
                        payload={"retry_in": max(0.0, state.cooldown - delta)},
                    )
            info[direction_norm] = int(info.get(direction_norm, 0)) + 1
            seq = state.next_seq
            event = {
                "seq": seq,
                "buttonId": button_id,
                "label": info["label"],
                "direction": direction_norm,
                "clientId": client_id,
                "timestamp": now,
            }
            state.events.append(event)
            if len(state.events) > MAX_BUTTON_EVENTS:
                state.events = state.events[-MAX_BUTTON_EVENTS:]
            state.last_by_client[client_id] = now
            state.next_seq = seq + 1
            state.updated = now
            await self._save_state(panel_id, state)
            return event

    async def state(self, panel_id: str, since: Optional[int] = None) -> Dict[str, Any]:
        async with self._lock(panel_id):
            state = self._ensure_loaded(panel_id)
            buttons = {
                button_id: {
                    "label": info["label"],
                    "minus": info["minus"],
                    "plus": info["plus"],
                }
                for button_id, info in state.buttons.items()
            }
            if since is None:
                events = [dict(item) for item in state.events]
            else:
                events = [dict(item) for item in state.events if item.get("seq", 0) > since]
            return {
                "panelId": panel_id,
                "buttons": buttons,
                "events": events,
                "nextSeq": state.next_seq,
                "locked": state.locked,
                "cooldown": state.cooldown,
                "updated": state.updated,
            }

    async def reset(self, panel_id: str) -> Dict[str, Any]:
        async with self._lock(panel_id):
            state = self._ensure_loaded(panel_id)
            for info in state.buttons.values():
                info["minus"] = 0
                info["plus"] = 0
            state.events.clear()
            state.last_by_client.clear()
            state.next_seq = 1
            state.updated = time.time()
            await self._save_state(panel_id, state)
            return self._config_snapshot(panel_id, state)

    def list_panel_ids(self) -> List[str]:
        panel_ids = set(self._states.keys())
        panel_ids.add(DEFAULT_BUTTON_PANEL)
        for path in DATA_DIR.glob("buttons_*.json"):
            stem = path.stem
            if stem.startswith("buttons_"):
                panel_ids.add(stem[8:])
        return sorted(panel_ids)


forms_store = FormManager()
buttons_store = ButtonManager()


class NavigationHub:
    def __init__(self) -> None:
        self._groups: Dict[str, Set[WebSocket]] = {}
        self._assignments: Dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()
        self._last_command: Optional[Dict[str, Any]] = None
        self._default_target: Optional[str] = None

    async def register(self, group: str, ws: WebSocket) -> None:
        async with self._lock:
            group = group or "all"
            self._groups.setdefault(group, set()).add(ws)
            self._assignments[ws] = group

    async def unregister(self, ws: WebSocket) -> None:
        async with self._lock:
            group = self._assignments.pop(ws, None)
            if group:
                group_set = self._groups.get(group)
                if group_set:
                    group_set.discard(ws)
                    if not group_set:
                        self._groups.pop(group, None)

    async def broadcast(self, group: str, message: Dict[str, Any]) -> None:
        data = json.dumps(message, ensure_ascii=False)
        async with self._lock:
            if group == "all" or not group:
                targets = set()
                for sockets in self._groups.values():
                    targets.update(sockets)
            else:
                targets = set(self._groups.get(group, set()))
            self._last_command = {
                "group": group or "all",
                "message": message,
                "ts": time.time(),
            }
        dead: List[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.unregister(ws)

    async def status(self) -> Dict[str, Any]:
        async with self._lock:
            return {
                "groups": {group: len(sockets) for group, sockets in self._groups.items()},
                "last": self._last_command,
                "default": self._default_target,
            }

    async def set_default(self, target: Optional[str]) -> None:
        async with self._lock:
            self._default_target = target or None

    async def get_default(self) -> Optional[str]:
        async with self._lock:
            return self._default_target


nav_hub = NavigationHub()


class FormSubmitRequest(BaseModel):
    formId: Optional[str] = None
    clientId: str = Field(..., min_length=1, max_length=128)
    answer: str = Field(..., min_length=1, max_length=MAX_FORM_ANSWER_LENGTH)


class FormConfigRequest(BaseModel):
    formId: Optional[str] = None
    question: Optional[str] = Field(default=None, max_length=280)
    cooldown: Optional[float] = None
    allowRepeat: Optional[bool] = None
    locked: Optional[bool] = None


class ButtonFireRequest(BaseModel):
    panelId: Optional[str] = None
    clientId: str = Field(..., min_length=1, max_length=128)
    buttonId: str = Field(..., min_length=1, max_length=64)
    direction: str = Field(..., min_length=1, max_length=16)


class ButtonConfigRequest(BaseModel):
    panelId: Optional[str] = None
    cooldown: Optional[float] = None
    locked: Optional[bool] = None


def _form_error_to_http(exc: FormError) -> None:
    detail = {"error": exc.code, "message": str(exc)}
    detail.update(exc.payload)
    raise HTTPException(status_code=exc.status, detail=detail)


def _button_error_to_http(exc: ButtonError) -> None:
    detail = {"error": exc.code, "message": str(exc)}
    detail.update(exc.payload)
    raise HTTPException(status_code=exc.status, detail=detail)


class RouterCommandRequest(BaseModel):
    action: str = Field(default="navigate", pattern="^(navigate|reload)$")
    target: Optional[str] = None
    group: Optional[str] = None
    preserveClient: bool = True
    preserveParams: Optional[List[str]] = None
    setDefault: Optional[bool] = True


def list_sources() -> List[str]:
    files = []
    for path in sorted(WWWDOCS_DIR.glob("*")):
        if path.is_file() and path.suffix.lower() in {".txt", ".md", ".html"}:
            files.append(path.name)
    return files

root_path = (os.getenv("BASE_PATH") or "").rstrip("/")
app = FastAPI(title="Highlight Local Server", root_path=root_path or "")
app.mount("/docs", StaticFiles(directory=PUBLIC_DIR, html=True), name="docs")


def sanitize_doc_id(raw: Optional[str]) -> str:
    doc_id = raw or DEFAULT_DOC_ID
    if not DOC_ID_RE.fullmatch(doc_id):
        raise HTTPException(status_code=400, detail="Invalid doc id")
    return doc_id


def sanitize_form_id(raw: Optional[str]) -> str:
    form_id = (raw or DEFAULT_FORM_ID).strip()
    if not FORM_ID_RE.fullmatch(form_id):
        cleaned = re.sub(r"[^A-Za-z0-9_.-]", "", form_id)[:64]
        form_id = cleaned or DEFAULT_FORM_ID
    return form_id


def sanitize_panel_id(raw: Optional[str]) -> str:
    panel_id = (raw or DEFAULT_BUTTON_PANEL).strip()
    if not PANEL_ID_RE.fullmatch(panel_id):
        cleaned = re.sub(r"[^A-Za-z0-9_.-]", "", panel_id)[:64]
        panel_id = cleaned or DEFAULT_BUTTON_PANEL
    return panel_id


def is_markdown_name(name: Optional[str]) -> bool:
    return bool(name and name.lower().endswith(".md"))


def _strip_bom(text: str) -> str:
    if "\ufeff" in text:
        return text.replace("\ufeff", "")
    return text


def top_color_at(bucket: Dict[str, str]) -> str:
    counts: Dict[str, int] = {}
    for color in bucket.values():
        if not color:
            continue
        counts[color] = counts.get(color, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda item: item[1])[0]


def ranges_from_votes(votes: List[Dict[str, str]]) -> List[Dict]:
    ranges: List[Dict] = []
    i = 0
    total = len(votes)
    while i < total:
        color = top_color_at(votes[i])
        if not color:
            i += 1
            continue
        j = i
        while j + 1 < total and top_color_at(votes[j + 1]) == color:
            j += 1
        ranges.append({"start": i, "end": j, "color": color})
        i = j + 1
    return ranges


def hash_id(value: str) -> str:
    import hashlib

    try:
        return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]
    except Exception:
        return value[:10]


def client_ranges(tokens: List[str], votes: List[Dict[str, str]], client_id: str) -> List[Dict]:
    res: List[Dict] = []
    limit = min(len(tokens), len(votes))
    idx = 0
    while idx < limit:
        color = votes[idx].get(client_id, "")
        if not color or is_break_token(tokens[idx]):
            idx += 1
            continue
        start = idx
        j = idx + 1
        while j < limit and not is_break_token(tokens[j]) and votes[j].get(client_id, "") == color:
            j += 1
        res.append({"start": start, "end": j - 1, "color": color})
        idx = j
    return res


def phrases_aggregated(tokens: List[str], votes: List[Dict[str, str]]) -> List[Dict]:
    from collections import defaultdict

    n = min(len(tokens), len(votes))
    clients: Set[str] = set()
    for idx in range(n):
        clients.update(votes[idx].keys())
    by_key: Dict[tuple, Set[str]] = defaultdict(set)
    for client_id in clients:
        hashed = hash_id(client_id)
        i = 0
        while i < n:
            if is_break_token(tokens[i]):
                i += 1
                continue
            color = votes[i].get(client_id, "")
            if not color:
                i += 1
                continue
            start = i
            j = i + 1
            while j < n and not is_break_token(tokens[j]) and votes[j].get(client_id, "") == color:
                j += 1
            phrase_tokens = tokens[start:j]
            phrase_text = " ".join(phrase_tokens).strip()
            if phrase_text:
                key = (phrase_text.lower(), color)
                by_key[key].add(hashed)
            i = j
    result: List[Dict] = []
    for (text_norm, color), clients_set in by_key.items():
        if not text_norm:
            continue
        result.append(
            {
                "text": text_norm,
                "color": color,
                "clients": sorted(clients_set),
                "count": len(clients_set),
            }
        )
    return result


@app.middleware("http")
async def log_requests(request, call_next):
    LOGGER.info("HTTP %s %s", request.method, request.url.path)
    response = await call_next(request)
    return response


@app.get("/api/docs")
async def api_docs() -> Dict[str, Any]:
    return {"docs": store.list_document_ids()}


@app.get("/api/forms")
async def api_forms_list() -> Dict[str, Any]:
    return {"forms": forms_store.list_form_ids()}


@app.get("/api/sources")
async def api_sources() -> Dict[str, Any]:
    return {"sources": list_sources()}


@app.get("/api/panels")
async def api_panels_list() -> Dict[str, Any]:
    return {"panels": buttons_store.list_panel_ids()}


@app.get("/api/text", response_class=PlainTextResponse)
async def api_text(name: Optional[str] = Query(None)) -> PlainTextResponse:
    text = store.read_source_text(name)
    sanitized = store._sanitize_source_name(name) if name else DEFAULT_SOURCE_NAME
    if is_markdown_name(sanitized):
        html_rendered = markdown_to_html(text)
        return PlainTextResponse(html_rendered, media_type="text/html; charset=utf-8")
    return PlainTextResponse(text, media_type="text/plain; charset=utf-8")


@app.get("/api/tokens")
async def api_tokens(
    doc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    state = await store.ensure_tokens(doc_id, name)
    return {"docId": doc_id, "tokens": state.tokens}


@app.get("/api/state")
async def api_state(
    doc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    state = await store.ensure_tokens(doc_id, name)
    payload = {
        "docId": doc_id,
        "updated": state.updated,
        "tokens_len": len(state.tokens),
        "ranges": ranges_from_votes(state.votes),
    }
    return payload


@app.get("/api/myranges")
async def api_myranges(
    doc: Optional[str] = Query(None),
    client: Optional[str] = Query(None),
) -> Dict:
    if not client:
        raise HTTPException(status_code=400, detail="Missing client id")
    doc_id = sanitize_doc_id(doc)
    state = await store.ensure_tokens(doc_id, None)
    ranges = client_ranges(state.tokens, state.votes, client)
    return {"docId": doc_id, "ranges": ranges}


@app.get("/api/phrases")
async def api_phrases(
    doc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    state = await store.ensure_tokens(doc_id, name)
    phrases = phrases_aggregated(state.tokens, state.votes)
    return {"docId": doc_id, "updated": state.updated, "phrases": phrases}


@app.get("/api/control")
async def api_control(
    action: str = Query(..., pattern="^(lock|unlock)$"),
    doc: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    if action == "lock":
        store.set_locked(doc_id, True)
    elif action == "unlock":
        store.set_locked(doc_id, False)
    await store.broadcast(doc_id, {"type": "control", "action": action, "docId": doc_id})
    return {"ok": True, "docId": doc_id, "locked": store.is_locked(doc_id)}


@app.get("/api/clear")
async def api_clear(
    doc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    await store.ensure_tokens(doc_id, name)
    await store.clear_votes(doc_id)
    await store.broadcast(doc_id, {"type": "state_updated", "docId": doc_id})
    return {"ok": True, "docId": doc_id, "cleared": "votes"}


@app.get("/api/reset")
async def api_reset(
    doc: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
) -> Dict:
    doc_id = sanitize_doc_id(doc)
    state = await store.retokenize(doc_id, name)
    await store.broadcast(doc_id, {"type": "state_updated", "docId": doc_id})
    return {"ok": True, "docId": doc_id, "reset": len(state.tokens), "sourceName": state.source_name}


@app.get("/api/export")
async def api_export(
    doc: Optional[str] = Query(None),
    fmt: Optional[str] = Query("json"),
):
    doc_id = sanitize_doc_id(doc)
    state = await store.ensure_tokens(doc_id, None)
    payload = {
        "docId": doc_id,
        "locked": store.is_locked(doc_id),
        "tokens": state.tokens,
        "votes": state.votes,
        "updated": state.updated,
        "sourceName": state.source_name,
    }
    fmt_lower = (fmt or "json").lower()
    if fmt_lower == "json":
        return JSONResponse(payload)
    if fmt_lower == "jsonl":
        out_path = store._jsonl_path(doc_id)
        with out_path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return FileResponse(
            out_path,
            media_type="application/octet-stream",
            filename=out_path.name,
        )
    raise HTTPException(status_code=400, detail="fmt must be json or jsonl")



@app.get("/api/forms/config")
async def api_forms_config(form: Optional[str] = Query(None)) -> Dict:
    form_id = sanitize_form_id(form)
    return await forms_store.get_config(form_id)


@app.post("/api/forms/config")
async def api_forms_config_update(payload: FormConfigRequest) -> Dict:
    form_id = sanitize_form_id(payload.formId)
    question = payload.question.strip() if payload.question is not None else None
    try:
        return await forms_store.update_config(
            form_id,
            question=question,
            cooldown=payload.cooldown,
            allow_repeat=payload.allowRepeat,
            locked=payload.locked,
        )
    except FormError as exc:
        _form_error_to_http(exc)


@app.get("/api/forms/control")
async def api_forms_control(
    action: str = Query(..., pattern="^(lock|unlock)$"),
    form: Optional[str] = Query(None),
) -> Dict:
    form_id = sanitize_form_id(form)
    locked = action == "lock"
    return await forms_store.update_config(form_id, locked=locked)


@app.post("/api/forms/submit")
async def api_forms_submit(payload: FormSubmitRequest) -> Dict:
    form_id = sanitize_form_id(payload.formId)
    client_id = payload.clientId.strip()
    if not client_id:
        raise HTTPException(status_code=400, detail={"error": "invalid_client", "message": "clientId cannot be empty"})
    try:
        record = await forms_store.submit(form_id, client_id, payload.answer)
    except FormError as exc:
        _form_error_to_http(exc)
    return {"formId": form_id, "result": record}


@app.get("/api/forms/results")
async def api_forms_results(
    form: Optional[str] = Query(None),
    since: Optional[int] = Query(None),
) -> Dict:
    form_id = sanitize_form_id(form)
    return await forms_store.results(form_id, since)


@app.post("/api/forms/clear")
async def api_forms_clear(form: Optional[str] = Query(None)) -> Dict:
    form_id = sanitize_form_id(form)
    return await forms_store.clear(form_id)


@app.get("/api/triggers/config")
async def api_triggers_config(panel: Optional[str] = Query(None)) -> Dict:
    panel_id = sanitize_panel_id(panel)
    return await buttons_store.get_config(panel_id)


@app.post("/api/triggers/config")
async def api_triggers_config_update(payload: ButtonConfigRequest) -> Dict:
    panel_id = sanitize_panel_id(payload.panelId)
    try:
        return await buttons_store.update_config(
            panel_id,
            cooldown=payload.cooldown,
            locked=payload.locked,
        )
    except ButtonError as exc:
        _button_error_to_http(exc)


@app.get("/api/triggers/control")
async def api_triggers_control(
    action: str = Query(..., pattern="^(lock|unlock)$"),
    panel: Optional[str] = Query(None),
) -> Dict:
    panel_id = sanitize_panel_id(panel)
    locked = action == "lock"
    return await buttons_store.update_config(panel_id, locked=locked)


@app.post("/api/triggers/fire")
async def api_triggers_fire(payload: ButtonFireRequest) -> Dict:
    panel_id = sanitize_panel_id(payload.panelId)
    client_id = payload.clientId.strip()
    if not client_id:
        raise HTTPException(status_code=400, detail={"error": "invalid_client", "message": "clientId cannot be empty"})
    button_id = (payload.buttonId or "").strip().lower()
    if not button_id:
        raise HTTPException(status_code=400, detail={"error": "invalid_button", "message": "buttonId cannot be empty"})
    direction = (payload.direction or "").strip().lower()
    try:
        event = await buttons_store.fire(panel_id, client_id, button_id, direction)
    except ButtonError as exc:
        _button_error_to_http(exc)
    return {"panelId": panel_id, "event": event}


@app.get("/api/triggers/state")
async def api_triggers_state(
    panel: Optional[str] = Query(None),
    since: Optional[int] = Query(None),
) -> Dict:
    panel_id = sanitize_panel_id(panel)
    return await buttons_store.state(panel_id, since)


@app.post("/api/triggers/reset")
async def api_triggers_reset(panel: Optional[str] = Query(None)) -> Dict:
    panel_id = sanitize_panel_id(panel)
    return await buttons_store.reset(panel_id)


@app.post("/api/router/send")
async def api_router_send(payload: RouterCommandRequest) -> Dict[str, Any]:
    group = (payload.group or "all").strip() or "all"
    action = payload.action.lower()
    if action == "navigate":
        target = payload.target or ""
        if not target:
            raise HTTPException(status_code=400, detail="target is required for navigate action")
        message = {
            "type": "navigate",
            "target": target,
            "preserveClient": payload.preserveClient,
            "preserveParams": payload.preserveParams or [],
        }
    elif action == "reload":
        message = {"type": "reload"}
        if payload.target:
            message["target"] = payload.target
    else:
        raise HTTPException(status_code=400, detail="Unsupported router action")
    if action == "navigate" and (payload.setDefault is None or payload.setDefault):
        await nav_hub.set_default(message.get("target"))
    await nav_hub.broadcast(group, message)
    return {"ok": True, "group": group, "action": action}


@app.get("/api/router/status")
async def api_router_status() -> Dict[str, Any]:
    return await nav_hub.status()


@app.get("/api/router/default")
async def api_router_default() -> Dict[str, Any]:
    target = await nav_hub.get_default()
    return {"default": target}


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "landing.html", media_type="text/html")


@app.get("/index.html", include_in_schema=False)
async def index_alias() -> FileResponse:
    return FileResponse(PUBLIC_DIR / "landing.html", media_type="text/html")


@app.websocket("/")
async def websocket_endpoint(websocket: WebSocket) -> None:
    params = websocket.query_params
    doc_id = sanitize_doc_id(params.get("doc"))
    client_id = params.get("client") or "anon"
    await websocket.accept()
    LOGGER.info("WS open doc=%s client=%s", doc_id, client_id)
    store.register_ws(doc_id, websocket)
    try:
        state = await store.ensure_tokens(doc_id, None)
        await websocket.send_json({"type": "hello", "docId": doc_id, "locked": store.is_locked(doc_id)})
        if state.tokens:
            await websocket.send_json(
                {
                    "type": "init",
                    "docId": doc_id,
                    "ranges": ranges_from_votes(state.votes),
                    "t": state.updated,
                }
            )
        while True:
            try:
                message = await websocket.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception as exc:
                LOGGER.warning("WS parse error from %s: %s", client_id, exc)
                continue
            await handle_ws_message(doc_id, client_id, message)
    except WebSocketDisconnect:
        LOGGER.info("WS closed doc=%s client=%s", doc_id, client_id)
    finally:
        store.unregister_ws(doc_id, websocket)


@app.websocket("/control")
async def websocket_control(websocket: WebSocket) -> None:
    params = websocket.query_params
    group = params.get("group") or "all"
    client_id = params.get("client") or "anon"
    await websocket.accept()
    await nav_hub.register(group, websocket)
    try:
        await websocket.send_json({"type": "control_hello", "group": group, "clientId": client_id})
        while True:
            try:
                await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except Exception:
                continue
    finally:
        await nav_hub.unregister(websocket)


async def handle_ws_message(doc_id: str, client_id: str, message: Dict) -> None:
    if message.get("type") != "highlight":
        return
    action = message.get("action")
    timestamp = message.get("t")
    if action == "set_range":
        start = int(message.get("start", 0))
        end = int(message.get("end", start))
        color = message.get("color") or ""
        changed = await store.apply_highlight(doc_id, client_id, start, end, color, timestamp)
        if changed:
            await store.broadcast(doc_id, {"type": "state_updated", "docId": doc_id})
    elif action == "clear_all":
        changed = await store.clear_client(doc_id, client_id, timestamp)
        if changed:
            await store.broadcast(doc_id, {"type": "state_updated", "docId": doc_id})


def main() -> None:
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9988"))
    LOGGER.info("Starting server on %s:%s", host, port)
    uvicorn.run(app, host=host, port=port, reload=False, log_level="info")


if __name__ == "__main__":
    main()
