---
id: submodule-server-lsp
type: submodule-design
status: active
title: lsp — WebSocket-to-stdio bridge to a spawned language server
parent: module-server
tags: [host, public-surface-checked]
---

## Responsibility

Carry LSP JSON-RPC between a browser language client and a language-server process: one WebSocket at
`GET /lsp?language=<id>&root=<workspace-root>` per editor session, piped to a spawned child. A WebSocket
message is one JSON-RPC message, the child speaks `Content-Length`-framed stdio, and no other LSP framing is
touched. The one thing this module decides is **which project a session analyzes and which Python
environment that project installed its libraries into**: `root` is that project's absolute directory (never
this process's cwd), the child runs with it as its `cwd`, and the environment found there is both activated
for the child and handed to it as the client's own configuration.

## Boundary

- **Public surface:** `LSP_ROUTE`, `LspSocket`, `LspServerCommand`, `LspSessionHandle`, `PythonEnvironment`,
  `closeAllLspSessions`, `closeLspSession`, `openLspSession`, `readLspMessage`, `resolvePythonEnvironment`,
  `resolveServerCommand`.
- **The language allow-list** (`python` → `pyright`, `typescript`/`javascript` → `typescript-language-server`)
  resolves each server through its installed package's own `bin` entry, so a language with no installed server
  is known **before** the socket upgrades and answers 400 rather than opening a socket that dies.
  `LspSocket` is the three socket members this module needs, so the bridge imports neither `host` nor a Bun
  socket type; `host` drives `openLspSession` / `readLspMessage` / `closeLspSession` / `closeAllLspSessions`
  from its `Bun.serve` websocket handlers.
- **One child per connection**, killed when that socket closes and by `host`'s `stop()`. A child that dies on
  its own ends the connection: a client left attached to a dead server waits forever for answers that never
  arrive.
- **A language server resolves imports from an interpreter, and only this host can find one** (`pythonEnv`).
  A workspace's environment is searched in the order a project most likely means it: its own
  `pyrightconfig.json` (`venvPath` + `venv`, or a named interpreter), an environment directory beside the
  workspace or beside its parent, the `VIRTUAL_ENV` / `CONDA_PREFIX` this process was started with, an
  environment a tool created under the user's home for the project's name, then the interpreter the host's
  PATH names. Nothing is ever run to ask a question a directory answers: no `conda env list`, no
  `python -c`, no `sys.path`. The result is carried to the server twice — as the child's own environment
  (`VIRTUAL_ENV`, its `bin` first on `PATH`) and as `python.pythonPath` plus
  `python.analysis.extraPaths`, which are the two settings pyright acts on. Giving pyright an
  `python.analysis` object switches its `autoSearchPaths` default off, so it is named.
- **A server speaks to its client, not only to it.** After `initialize`, both allowed servers send requests
  of their own, and they hold completion and hover until they are answered. The two configuration ones are
  answered **here** — `workspace/configuration` is looked up in the settings above, and the same settings go
  to the child as the `workspace/didChangeConfiguration` a server reads when its client offers no way to be
  asked — because a client cannot answer them about a filesystem it cannot see. Everything else a server asks
  (`client/registerCapability`, `window/workDoneProgress/create`) still reaches the app's own client
  (`resource-renderers` `lspClient`), whose replies decide whether that feature request ever comes back.
  `host/lspRoute.test.ts` carries a session of each language through initialize → advertised capabilities →
  didOpen → publishDiagnostics → completion → hover → definition → references, confirms the one child its
  socket spawned is the only one running and is gone once that socket closes, resolves an installed package
  out of a fixture `.venv`, and keeps the standard library working for a workspace with no environment.
- **Allowed deps:** `vscode-ws-jsonrpc` (plus the `vscode-jsonrpc` framing it carries), `node:child_process`,
  `node:fs`/`node:path`/`node:os`, `jsonc-parser` (`pyrightconfig.json` is JSONC), `../log`. No `ws` package:
  the upgrade is `Bun.serve`'s own, and a `WebSocketServer` of its own would be a second listener with a
  second origin the client would have to learn.
- **Forbidden:** `contracts` request types, the WS request registry and channels, `host`, every other feature
  module, and any LSP semantics (completion, hover, diagnostics) of its own beyond the configuration above.
- `subprocess` is not the runner here: it completes a child and returns its output, where a language server is
  a long-lived pipe.

## Known limits

- A server is found through the installed tree (`require.resolve("<package>/package.json")` plus its `bin`),
  so a compiled binary with no `node_modules` cannot launch one yet; staging these children is
  `build-support`'s job when the feature ships there.
- No multiplexing: two clients on one language run two servers (pyright is the expensive one). Add a shared
  child per language only when that cost shows up in a real session.
- An environment is resolved once, when the socket opens. A `.venv` created or moved while a file is open
  takes effect on the next session, not the open one; and an environment outside the workspace is found by
  directory shape, not by asking `conda`/`poetry`/`uv` what they created.
- The analysis root is the `root` the client asked for, so an `/lsp` reader is **not** path-contained the way
  `GET /files` is. That matches `/ws`, which already serves the whole host API to anything that can reach the
  port, and the host binds loopback by default; re-open this if the host ever listens beyond loopback. A
  session with no `root` — a host that cannot name its workspace — gets no settings and no activated
  environment, and its server analyzes whatever its own `initialize` carries.
- Frame size and backpressure follow `Bun.serve`'s WebSocket defaults (16 MiB inbound, close-on-overflow send
  buffer). Tune the upgrade only when a real file proves a language server exceeds them.
