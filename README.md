# Highlight Workshop Server

FastAPI backend that replicates the TouchDesigner highlight workflow, adds dedicated survey and button-control pages, and persists all state on disk for offline/local-network shows.

## Project layout

```
project-root/
- public/          static pages served from /docs/*
- server/          FastAPI application code
- wwwdocs/         source documents (txt/html/md)
- data/            persisted state (auto-created)
- touchdesigner/   helper scripts for TouchDesigner
- requirements.txt Python dependencies
- run_server.bat   Windows launcher
- README.md
```

## Installation

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate      # macOS / Linux
pip install -r requirements.txt
```

## Launching the server

### Windows shortcut

```
run_server.bat
```

The batch script activates the virtualenv, prints the detected IPv4 address, binds to `0.0.0.0:9988`, and starts the app (handy for QR codes on site).

### Manual launch

```bash
HOST=0.0.0.0 PORT=9988 python server/server.py
```

Environment variables: `HOST` (default `0.0.0.0`), `PORT` (default `9988`), `BASE_PATH` (optional URL prefix).

## Static pages (served from `/docs/`)

- `index_sender.html` - participant highlighter (`render=text|html|markdown`).
- `cloud.html` - aggregated word cloud.
- `form.html` - "send text" survey (`form=<id>`, default `feedback`).
- `buttons.html` - button control panel (`panel=<id>`, default `main`).
- `admin.html` - dashboard for navigation, surveys, and button logs.

Example URLs (replace `<host>` with the LAN IP printed by the launcher):

- `http://<host>:9988/docs/index_sender.html?doc=Demo&name=text.txt&render=text&overlay=own`
- `http://<host>:9988/docs/index_sender.html?doc=Demo&name=text.md&render=markdown&overlay=own`
- `http://<host>:9988/docs/cloud.html?doc=Demo`
- `http://<host>:9988/docs/form.html?form=feedback`
- `http://<host>:9988/docs/buttons.html?panel=main`
- `http://<host>:9988/docs/admin.html`\n- `http://<host>:9988/` (participants)

Documents load from `wwwdocs/<name>` (default `text.txt`). Markdown sources (`*.md`) are rendered to HTML while keeping token indices aligned; after swapping the source file, call `GET /api/reset?doc=<id>&name=<file>` to retokenise and clear votes.
The landing agreement is read from `wwwdocs/agreement.md` (customize this file for your event).

## API overview

### Highlight endpoints

- `GET /api/docs` - list known document IDs (`state_*.json`).
- `GET /api/sources` - list available sources in `wwwdocs/` (`.txt/.md/.html`).
- `GET /api/text?name=<file>` - raw text (markdown returns rendered HTML).
- `GET /api/tokens?doc=<id>&name=<file>` - token list.
- `GET /api/state?doc=<id>` - dominant overlay ranges.
- `GET /api/myranges?doc=<id>&client=<id>` - client-specific ranges.
- `GET /api/phrases?doc=<id>` - aggregated phrases for the cloud view.
- `GET /api/control?action=lock|unlock&doc=<id>` - lock/unlock highlighting.
- `GET /api/clear?doc=<id>` - clear votes, keep tokens.
- `GET /api/reset?doc=<id>&name=<file>` - retokenise + clear votes.
- `GET /api/export?doc=<id>&fmt=json|jsonl` - export current state.
- WebSocket `ws://<host>:<port>/?doc=<id>&client=<id>` - `hello`, `init`, `state_updated`, `control` messages.

### Survey ("Send Text") endpoints

- `GET /api/forms` - list known form IDs.
- `GET /api/forms/config?form=<id>` - question, cooldown, repeat flag, locked state.
- `POST /api/forms/config` - update `{formId?, question?, cooldown?, allowRepeat?, locked?}`.
- `GET /api/forms/control?action=lock|unlock&form=<id>` - quick lock toggle.
- `POST /api/forms/submit` - submit answer `{formId?, clientId, answer}` (cooldown enforced server-side).
- `GET /api/forms/results?form=<id>&since=<seq?>` - ordered responses.
- `POST /api/forms/clear?form=<id>` - remove all stored responses.

Responses persist in `data/form_<id>.json` with UNIX timestamps (`submitted`).

### Button panel endpoints

- `GET /api/panels` - list known panel IDs.
- `GET /api/triggers/config?panel=<id>` - button labels, counts, cooldown, locked state.
- `POST /api/triggers/config` - update `{panelId?, cooldown?, locked?}`.
- `GET /api/triggers/control?action=lock|unlock&panel=<id>` - quick lock toggle.
- `POST /api/triggers/fire` - register press `{panelId?, clientId, buttonId, direction}` where direction is `minus|plus`.
- `GET /api/triggers/state?panel=<id>&since=<seq?>` - counts plus incremental event feed.
- `POST /api/triggers/reset?panel=<id>` - reset counts and event log.

Panel state lives in `data/buttons_<id>.json` (events include UNIX `timestamp`).

### Remote navigation

- `POST /api/router/send` - broadcast navigation or reload commands (`group`, `action`, `target`, `preserveClient`, `preserveParams`).
- `GET /api/router/status` - current router groups and last command.
- WebSocket `ws://<host>:<port>/control?group=<name>&client=<id>` - pages listen for `navigate` / `reload` instructions (client ID is preserved automatically unless disabled).

## Preloading highlight state

- Copy `data/state_template.json` to `data/state_<DocId>.json` and adjust `tokens` / `votes` before starting.
- `votes` are stored as `{ clientId: colorId }` per token index (`c1..c5` match the UI palette).

## TouchDesigner integration

- HTTP DATs can poll `GET /api/phrases`, `GET /api/forms/results`, and `GET /api/triggers/state` for dashboards.
- Subscribe to the highlight WebSocket (`state_updated`) and, if you use remote navigation, the `/control` channel.
- Use `touchdesigner/highlightEXT.py` as an extension inside a Base COMP:

  ```python
  base = op('base_highlight')
  base.ExtendDAT('touchdesigner/highlightEXT.py')
  base.ext.Highlight.SetWebClient(op('webclient1'), 'http://<host>:9988')
  base.ext.Highlight.FetchPhrases(op('phrases_table'))
  base.ext.Highlight.FetchFormResults(op('form_results'))
  base.ext.Highlight.FetchButtonEvents(op('button_events'))
  ```

  Each call rewrites the target Table DAT with the latest phrases, survey responses, or button press log.

## Persistence guarantees

- All writes go through temp files followed by atomic `os.replace` inside `data/`.
- Highlight, survey, and button states are sharded per document/form/panel (`state_*.json`, `form_*.json`, `buttons_*.json`).
- JSONL exports land next to the JSON state files (`data/state_<doc>.jsonl`).
