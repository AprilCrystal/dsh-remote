# dsh-openai-bridge

An OpenAI-compatible HTTP face for the DeepSeek Harness, so a phone running the
**Chatbox** app can drive a DSH session.

The package is named `dsh-openai-bridge`; its repository is
[`AprilCrystal/dsh-remote`](https://github.com/AprilCrystal/dsh-remote).

**中文使用指南 → [GUIDE.zh.md](GUIDE.zh.md)** — 面向使用者（怎么登录、各个按钮干什么、权限验证码、引用文件与上传的区别、安全边界、常见问题）。本文件面向开发者。

## Install

```sh
dsh plugin --profile <your-profile> add github:AprilCrystal/dsh-remote
```

**Nothing needs to be built, and nothing needs to be allowlisted.** A `github:`
install fetches sources rather than built artifacts, which normally forces the
author to ship a `prepare` script and the user to grant a pnpm `allowBuilds`
permission — i.e. permission to execute the package's code at install time. This
package sidesteps all of it: every entry point under `lib/` is plain ESM
JavaScript and is committed as-is, so there is no build step to run.

Then give it a token. The bundle layer reads it from the environment, so either
export it or set it in the profile's `cordis.patch.yml`:

```sh
DSH_OPENAI_BRIDGE_TOKEN=<a-long-random-secret>
```

**An empty token means the bridge does not mount at all.** It fails closed rather
than exposing an unauthenticated endpoint.

## What it gives you

- `GET  /v1/models` — advertises `dsh-agent` (start a conversation) plus **one
  entry per DSH session**, labelled `<title> · <sessionId>`.
- `POST /v1/chat/completions` — streaming (SSE) and non-streaming.

Point Chatbox at it with **Settings → Model Provider → Add → Add Custom
Provider → "OpenAI API Compatible"**:

| Field | Value |
|---|---|
| API Key | the value in `$DSH_HOME/openai-bridge.token` (or `DSH_OPENAI_BRIDGE_TOKEN`) |
| API Host | `http://<this-machine-lan-ip>:19387/v1/` |
| API Path | `/chat/completions` |
| Model ID | `dsh-agent` |

## Safety model — read this before exposing it

**The bridge is loopback-only by default.** It mounts on the *existing*
webserver and inherits that server's bind, which is `127.0.0.1` unless a
deployment deliberately patches the `webserver` row to `0.0.0.0`. This plugin
never widens the bind itself.

**Every session the bridge drives is pinned to the `read-only` permission
preset** (`sandbox: read-only` + `approval: ask`, shipped in the base bundle).
A write attempt is refused by the sandbox and turns into an approval request.
That request is forwarded to connected browser clients, so it surfaces in the
**local desktop GUI** — a plain OpenAI chat client cannot render or answer one.

Three consequences worth being explicit about:

1. **This protects integrity, not confidentiality.** Per
   `packages/sandbox/sandbox/src/index.ts`, the sandbox is a *file-effect*
   policy: "Network and process visibility are outside this vocabulary."
   `read-only` blocks writes; it does **not** block reading your files,
   executing commands, or network egress. Anyone holding the token can read and
   exfiltrate, just not modify.
2. **The approval prompt needs a GUI that has the session open.** If nothing is
   listening, the request sits pending until a client answers it.
3. **Plain HTTP.** Over Wi-Fi the bearer token and any session cookie travel in
   cleartext. Do not run this on an untrusted network.

## Configuration

Set through the bundle patch (`cordis.patch.yml`), each with an environment
override:

| Key | Env override | Default | Meaning |
|---|---|---|---|
| `token` | `DSH_OPENAI_BRIDGE_TOKEN` | `''` | **Empty disables the bridge entirely.** Fails closed. |
| `cwd` | `DSH_OPENAI_BRIDGE_CWD` | `process.cwd()` | Workspace root for bridge-created sessions. |
| `permissionPreset` | `DSH_OPENAI_BRIDGE_PERMISSION` | `read-only` | Preset pinned onto each **newly created** session. It is deliberately *not* re-pinned on later turns: doing that would silently reset a preset you changed. |
| `agentPreset` | `DSH_OPENAI_BRIDGE_PRESET` | `standard` | Agent preset each session is composed from. |
| `panelPath` | — | `/bridge` | Where the mobile panel mounts. |
| `fileRoot` | `DSH_OPENAI_BRIDGE_FILEROOT` | `cwd` | Browse roots for the panel. A string is one root, a list is several, `'*'` is every fixed drive. See [Browsing beyond the workspace](#browsing-beyond-the-workspace). |
| `approvalScope` | — | `all` | `all` lets the panel answer approvals for any session; `bridge` narrows it to sessions in `cwd`. |
| `permissionSwitch` | — | `true` | `false` removes the phone's permission switch entirely — no button, and the API 404s. |
| `permissionPresets` | — | `['read-only','workspace-write']` | Which presets the phone may request. `danger-full-access` is excluded on purpose. |
| `authorizationCode` | — | `''` | Non-empty switches the handshake to a fixed code you choose. Empty means the server mints a one-time code that is displayed on the desktop only. |
| `authorizationTtlMs` | — | `180000` | How long a pending authorization stays confirmable. |
| `desktopPopup` | — | `true` | Whether to auto-open the authorization popup on this PC. |

## Session mapping

OpenAI's protocol is stateless and carries **no conversation identity**, and a
client's conversation list is its own local storage — so a conversation started
in the desktop GUI is invisible to Chatbox. The only selector the protocol
offers is the model list, which is why `/v1/models` enumerates sessions: picking
one is how you continue a desktop conversation from the phone.

There are two ways a request is routed to a session, in priority order:

1. **An explicitly selected session.** If the `model` field embeds a DSH session
   id, that session is used — resumed if it is not live. Advertised ids are
   `<title> · <sessionId>` because an OpenAI model object has no display-name
   field, so the id *is* what the picker shows. Only the trailing session id is
   authoritative, and the whole string round-trips, so a client truncating the
   label for display cannot misroute anything.
2. **Inference from the opening message.** Any other `model` (notably the
   synthetic `dsh-agent`) falls back to a SHA-256 of the **first user message**.
   This is stable across turns and across restarts, but it is genuinely
   ambiguous: **two conversations that open with the same line collapse onto one
   session** and their turns interleave. Selecting a session explicitly is the
   way to avoid that; the collision is recorded as a test rather than papered
   over.

Either way the bridge forwards only the **newest** user message — the harness
already holds the prior turns in its own log — and editing a conversation's
first message starts a new session.

The list is capped at the 40 most recent sessions and cached for 5 seconds,
since every refresh re-reads the session corpus.

## Failure behaviour

Import and setup failures degrade to "bridge disabled" rather than propagating:
a plugin that throws during load can take the whole composition down with it,
which would lock the operator out of the very GUI they need in order to remove
it. Check the host log for `openai-bridge:` lines.

## Verified

Exercised end-to-end against a running desktop profile:

| Check | Result |
|---|---|
| `GET /v1/models` | 200; one `dsh-agent` entry before the session listing landed |
| Invalid token | 401 |
| Missing `Authorization` header | 401 |
| `POST /v1/chat/completions` (non-streaming) | 200, correct `chat.completion` shape |
| `POST /v1/chat/completions` (`stream: true`) | Correct `chat.completion.chunk` frames, terminated by `data: [DONE]` |
| `read-only` preset actually pinned | Agent self-reported its file policy as `read-only` |
| Second turn in the same conversation | Mapped to the same session, only the newest message forwarded |
| `0.0.0.0` bind | Server reachable on the LAN address, and from a phone |
| Panel sign-in (`?token=`) | 303 + `Set-Cookie`, then `/bridge/` serves the shell |
| Slashless `/bridge` | 308 to `/bridge/`, so relative API fetches resolve correctly |
| Panel auth fence | 401 without the cookie or bearer token |
| Session list / transcript APIs | 200 with real data; typeless titles gone |
| Symlink escape from the browse root | **Rejected** — ran once `symlink()` was permitted (it needs elevation on Windows); only the post-`realpath` re-check catches this, so the second fence is proven, not assumed |
| Typed transcript blocks, live | `{"text":138,"reasoning":182,"tool-call":285}` on one session — 467 of 605 blocks fold away |
| `test/panel.test.mjs` | 45 assertions green; **47 when run elevated**, where the two symlink-containment assertions execute instead of skipping |
| `test/permission.test.mjs` | 53 assertions green — the code-confinement property is asserted negatively |
| `test/model.test.mjs` | 35 assertions green — catalogue shaping, per-provider failure isolation, and selection validation |
| `test/browse.test.mjs` | 37 assertions green over real HTTP: the virtual root, relative single-root backwards compatibility, and the refusals — traversal, out-of-root absolute paths, and reading outside every root |
| `test/integration.test.mjs` | 37 assertions green against a real `node:http` server mounting the real panel: the auth guard covers the new asset, the routes are actually wired, the cookie bootstrap preserves the popup's `id`/`view` while dropping the token, and the full handshake completes |

207 assertions across five suites, plus a standalone guard for the panel's
single-template shell.

Still unverified: **how any of this renders on a real phone.** The server half of
the approval card, the permission dialog, the model picker and the file browser is
proven; the browser half has never been seen on a device.

Two bugs were caught by the live API rather than by reading source, and are
worth remembering: `readTitleSnapshot` returns a `{ session, title }` wrapper
(`readTitle` is the one returning the snapshot), and a tagged template yields
`undefined` for any segment holding an invalid escape — which silently degrades
the whole panel to the text "undefined" when its script contains a plain `\s`.

## The mobile panel (`/bridge`)

A phone-friendly, self-contained read-only page. Sign in once by opening
`http://<host>:19387/bridge?token=<token>`; that exchanges the URL token for an
`HttpOnly` cookie and redirects to a clean `/bridge/`, so the credential stops
travelling in the address bar and history.

| Tab | What it does |
|---|---|
| 会话 | Every DSH session — title, time, workspace, running/loaded badge. Tap one to read its full message transcript. Includes desktop sessions, which Chatbox cannot show. |
| 文件 | Browse the workspace, preview text files, download any file. Upload from the phone into `_inbox/`. |

### Driving a session from the panel

The transcript view carries a composer: type a message and the reply streams
into a live bubble. The panel drives sessions through **the same runtime as the
OpenAI face** (`ensureAgent` / `driveTurn`), so the permission preset and the
sandbox boundary cannot differ by entry point.

That gives you a choice of two ways to work:

- **Everything in the panel** — read, chat, and approve in one page.
- **Chat in Chatbox, approve in the panel** — keep your existing client.

### Approvals

The panel registers a **prepended** `approval/request` listener and asks the
panel and the desktop GUI **simultaneously**:

```js
const downstream = next()          // the desktop prompt is never delayed
const mine = new Promise(settle => pending.set(id, { decide: settle }))
return Promise.race([downstream, mine])
```

`next()` runs immediately rather than after the panel declines, so a person
already looking at the desktop prompt does not wait on a phone that happens to
be asleep. Whichever side answers first claims the decision, and the harness
discards a late answer, so the `approval/asked` / `approval/decided` audit pair
stays intact.

**Scope.** `approvalScope` is set to `all` here, and that is the setting that
matches the panel's own list: **whatever you can open and send a message to, you
can also approve.** The narrower `bridge` setting (only sessions whose workspace
is `cwd`) sounds safer, but it produces a genuinely confusing case — you open a
conversation in the panel, send it something that writes, and the prompt appears
only on the desktop with nothing on the phone to explain the silence. If you
want that narrowing anyway, set `approvalScope: bridge`.

Either way the desktop GUI is asked **in parallel**, so you can always approve at
the machine instead.

Pending approvals are **polled** at 2s rather than pushed: they are rare, the
latency is irrelevant, and polling needs no long-lived connection to survive a
phone sleeping. It is also why Chatbox can never show one — it speaks the OpenAI
protocol, which has no approval channel at all.

### Switching the permission preset from the phone

The header carries a chip showing the current preset. Tapping it offers the
presets the phone is allowed to request — `read-only` and `workspace-write`, and
**never `danger-full-access`**: widening the sandbox to the whole machine is the
one change that cannot be walked back from a phone if it is granted by mistake.

The change is not applied when you ask for it. It is applied when you prove you
are sitting at the machine:

1. the phone asks for a preset — nothing changes yet;
2. **this PC opens a popup** showing the request and a one-time 6-digit code;
3. the phone must send that code back before anything is applied.

The code is only ever rendered on the desktop. `GET /bridge/api/perm?action=state`
— the route the phone polls — omits it entirely, and the popup's own state route
refuses to answer without the per-request `view` key that only travels inside the
popup URL. `test/permission.test.mjs` asserts this negatively, because if a code
ever leaks into the phone's route the handshake degrades into "the phone
authorizes itself", which is the one thing the popup exists to prevent.

Set `authorizationCode` to pick the code yourself; then the popup only announces
the request instead of minting a code. Either way the desktop sees it. Wrong
codes burn an attempt (5, then the request is voided) and a request expires after
`authorizationTtlMs`.

**Why the approval waterfall is not reused here.** `ctx.approval.request` must be
raised from inside an *open turn* — the `approval/asked`/`approval/decided` audit
pair has to be enclosed by the session log's commit boundary, so an idle ask is
rejected before anything is appended. A preset change tapped on a panel is an
idle, turn-less action, so this handshake is its own small mechanism rather than
a misuse of that one.

**Honest scope.** The `view` key keeps the code away from the phone's own URL; it
is not a cryptographic boundary, because one bearer token authenticates every
surface and the LAN link is cleartext. `desktopPopup` spawns the machine's
default browser via `rundll32 url.dll,FileProtocolHandler`; if that fails the
handshake still works and the popup URL is written to the host log.

### The bottom-right action cluster

Everything secondary lives behind one button in the corner: the permission
preset, the model and its reasoning effort, **引用文件** (insert a path from this
machine into the composer), and the two scroll ends. These used to be header
chips, which squeezed the conversation title down to an ellipsis the moment there
were two of them.

The cluster measures the composer on every render and offsets itself by its
height, because the composer is sticky at the bottom of the viewport — so the
buttons never end up underneath the input. Each scroll button stays hidden at the
end it already sits at, and the stack collapses as soon as you scroll.

**引用文件** reuses the file browser in a picker mode: the header changes to
选择文件, tapping a file hands its path back, and the path is appended to the
composer. Directories still navigate normally. Nothing is uploaded and nothing is
written — this only puts a path into the message, which the agent then reads
through its own tools under the ordinary sandbox and approval rules.

### How a transcript renders

Each message is split into typed blocks against the harness's own
`ContentBlockMap`, and the two classes are treated differently:

- **`text` — the reply.** Rendered as Markdown, expanded: fenced code, inline
  code, headings, bold/italic, links, lists, blockquotes, rules.
- **Everything else — folded by default.** `reasoning` (思考), `tool-call`,
  `tool-result`, and attachments each collapse into a `<details>` the reader can
  open. A message carrying only folded blocks shows just its summary line,
  which is what keeps a long agent turn readable on a phone.

Markdown is built with DOM APIs and `textContent`, never `innerHTML`, so no
message content can become markup no matter what the model emits. `href` is the
one attribute text can reach, so link schemes are whitelisted to
`http`/`https`/`mailto`.

User turns are restricted to `source.kind === 'user'`; injected context
(runtime snapshots, tool notices) is filtered out rather than rendered, because
it would otherwise drown the conversation.

### Workspace

`cwd` is the workspace bridge-created sessions run in. It is currently set to
`E:\dsh-workspace\remote` so phone-driven agent activity stays out of the main
development tree. The session is also attached to that workspace through
`ctx.workspaceRegistry`, which is what makes it appear in the desktop sidebar —
without that, an approval raised for a phone-driven write would have no session
to surface in and the operator could not answer it.

### The `_inbox` carve-out — read this

Browsing and every read are harmless. **Upload is not**: it is a direct disk
write from an HTTP handler, which bypasses the DSH sandbox, the approval
waterfall, and the audit log.

So uploads are confined to exactly one directory, `<cwd>/_inbox/`, and the
panel can write nowhere else. Everything else on the machine — including the
agent editing any file — still goes through the sandbox and its approval prompt.
Treat `_inbox` as the one hole, and remember it sits outside the approval trail.

Path containment is enforced twice: `..` and out-of-scope absolute paths are
rejected against the resolved roots, and every target is `realpath`-checked
afterwards so a symlink cannot point outward.

### Browsing beyond the workspace

`fileRoot` is the browse allow-list and defaults to `cwd`. It takes three forms:

| Value | Meaning |
|---|---|
| `'E:\work'` | one root. Paths stay **relative** to it, exactly as they always did. |
| `['C:\', 'E:\work']` | several roots. A virtual root lists them; paths become absolute. |
| `'*'` | every fixed drive, enumerated live, so a drive mounted later needs no restart. |

```yaml
        fileRoot: '*'
```

Containment is unchanged in all three forms: `..` is refused textually, an
absolute path is accepted only when it lands inside **some** root, and the target
is `realpath`-checked afterwards so a symlink cannot point outward. The single
root form deliberately still refuses absolute paths, so an existing deployment
keeps the tighter behaviour it was configured with.

**This is the one setting worth pausing over.** Reads are already unrestricted
for the agent, so `'*'` does not widen what the *agent* can reach — it widens what
one bearer token, over a cleartext LAN link, can enumerate and download from a
phone. `read-only` protects integrity, not confidentiality, and nothing here
changes that. Scope it to a list if you want the browser useful without handing
over the whole machine.

Uploads do **not** follow the browse roots: they always land in `<cwd>/_inbox/`,
because with `'*'` the first root is a drive letter and `C:\_inbox` is not
somewhere to write.

### Switching the model from the phone

The header carries a second chip showing the model the session is using. Tapping
it lists real provider groups from the live LLM registry — with each provider's
models, their descriptions, and their reasoning efforts when the adapter declares
any. One provider that cannot enumerate is reported in place rather than blanking
the list.

Unlike the permission switch, **this needs no code from the desktop.** Choosing a
model cannot widen the sandbox, and it is trivially reversible, so gating it would
only add friction.

Picking a model that declares reasoning opens a second step for its **reasoning
effort**, including an explicit "adapter default" that clears an inherited one.
The effort rides on the same selection as the model — it is the same
`reasoningEffort` field the desktop's own picker sets — and the cluster button
shows it next to the model name.

A switch is applied to the *next* step, never mid-step. The bridge installs a
mutable selection onto each agent it creates and mirrors the harness's own
`installModelSelection`: prompt assembly snapshots the selection before
delegating, and request routing applies that snapshot, so the prompt and the
request can never disagree about which model is in play. That also means the
desktop GUI picks the change up, because its model indicator reads the same
request headers.

**One honest limitation.** A session the desktop already holds *live* never ran
this bridge's setup, so no selection of ours is coupled to it and flipping one
would silently do nothing. The picker detects that case and says so instead of
reporting a change that did not happen. Switch that one on the desktop, or start a
fresh conversation.

## Backing it out

Remove `dsh-openai-bridge` from `dsh.profile.bundles` (and `dependencies`) in
the profile's `package.json`, then restart.
