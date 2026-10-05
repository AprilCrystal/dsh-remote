# dsh-openai-bridge

An OpenAI-compatible HTTP face for the DeepSeek Harness, so a phone running the
**Chatbox** app can drive a DSH session.

The package is named `dsh-openai-bridge`; its repository is
[`AprilCrystal/dsh-remote`](https://github.com/AprilCrystal/dsh-remote).

**中文使用指南 → [GUIDE.zh.md](GUIDE.zh.md)** — 面向使用者（怎么登录、各个按钮干什么、权限验证码、引用文件与上传的区别、安全边界、常见问题）。本文件面向开发者。

**手机面板功能详解 → [PANEL.zh.md](PANEL.zh.md)** — 思考/复制/停止、插入消息与双端同步、分支对话、问答卡片：怎么用、边界在哪、哪些**还没在真机上验证过**。

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

**With no token the bridge does not mount — with one exception.** `GET /setup`
answers from this machine only (403 to every other peer) and is where you read the
address a phone should use and generate the token. Everything else — `/v1`,
`/bridge`, and the `approval/request` listener — stays unmounted, so an
unconfigured plugin still cannot touch the approval flow.

The token may be set here, or left to `$DSH_HOME/openai-bridge.token`, which the
setup page writes for you. A configured token always wins.

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

**The one route that answers before a token exists is `/setup`, and it is
restricted to this machine.** It checks the peer address and returns 403 to
anything that is not loopback — which matters precisely because a deployment that
DID patch the bind to `0.0.0.0` is reachable from the whole LAN, so the bind is
not the gate. That page shows the token and can write the token file; while the
token is empty, nothing else is mounted.

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
| `ipAllowlist` | — | `true` | Refuse every peer that has not been approved, whatever token it holds. Loopback never pairs. See [The per-client allowlist](#the-per-client-allowlist). |
| `pairingPath` | — | `/pair` | Where a not-yet-approved device posts its code. The only route reachable from the LAN without approval. |
| `pairingTtlMs` | — | `600000` | How long a minted pairing code stays valid. |
| `pairingAttempts` | — | `5` | Wrong codes tolerated per code before it is dead for the rest of its TTL. |
| `pairingPopup` | — | `true` | Open the setup page on this machine by itself when a device starts waiting. |
| `pairingPopupCooldownMs` | — | `15000` | Shortest gap between automatic popups, so a LAN sweep cannot spray windows. |
| `pairingMaxPending` | — | `16` | Waiting devices kept; past this the oldest is dropped. |

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

### `session "..." already exists`

Three defects produced this message. The first two were about losing a race and
then reporting it as a fact about the store; the third was the actual cause and
the reason the message existed at all.

**A guarded property read.** The model selection was installed from inside the
`setup` callback, where the only way to name the agent is `agentCtx.agent`. A
scoped context exposes only the services it declared it needs, so that read
throws `cannot get property "agent" without inject`. The throw escaped `setup`,
which failed every `resume` of an existing conversation — so the phone could
never continue one. The bridge then fell through to `create`, which answered
`session "..." already exists`: a message about the store, for a bug in a
listener. The selection is now installed after the agent exists, on `agent.ctx`,
which is what the harness's own installer documents and what its session
controller passes. Model switching from the phone had never worked either, for
the same reason — the install never completed.

**Concurrent acquisition.** `acquireAgent` chose between `resume` and `create` by
asking whether the session was live, so two callers asking for the same *cold*
session at the same moment both saw "not live", both reached `create`, and the
loser was answered with the id being taken. Only the turn path was serialized.
Every caller now goes through `ensureAgent`, which shares one in-flight
acquisition per session id — the same guard the harness's own session controller
keeps.

**A swallowed cause.** When the session really was on disk but `resume` failed,
the fallthrough discarded the reason and let `create` report the id as taken. The
create failure is now compared with the resume failure, so a create that lost to
a resume names the real cause — which is how the guarded read above was found.
Any other create failure is rethrown untouched.

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
| `test/model.test.mjs` | 41 assertions green — catalogue shaping, per-provider failure isolation, selection validation, and that the selection is never installed from the context `setup` receives |
| `test/context.test.mjs` | 85 assertions green — the occupancy fold (including that an unmeasured context is `null`, not 0%), the `ManualCompactionError` code mapping, service resolution, and the route contract |
| `test/clients.test.mjs` | 122 assertions green — an un-approved peer refused everything including the shell, the code never present in anything a remote peer can read, approval surviving a restart through `$DSH_HOME`, a dead code that expires instead of locking a device out forever, a manual replacement clearing that lock, one popup for a LAN sweep rather than one per address, and the same phone recognised when a dual-stack socket respells it |
| `test/output.test.mjs` | 31 assertions green — reasoning on its own callback and never on the OpenAI face, the fold built lazily, the stop route keeping queued input unless asked, a copy that admits when it could not copy, and that nothing above the composer is a scroll container (which is what let streamed output push the input down the page) |
| `test/queue.test.mjs` | 34 assertions green — every refusal and the target default, the panel route's wiring, that insert appends without waking the driver, that send-now removes then re-sends, that the plugin keeps no queue of its own, and that a poll cannot close the keyboard mid-edit |
| `test/fork.test.mjs` | 23 assertions green — the cut at a completed turn and never mid-turn, landing on the next turn boundary with trailing events left behind, clamping a seq that runs past the array, the route's wiring, that the child is seeded and parented, and that the source sandbox is NOT inherited |
| `test/recovery.test.mjs` | 34 assertions green — in-flight acquisition is shared per key (including by a reentrant caller), a failed key is freed, and a create that lost to a resume reports the real cause |
| `test/browse.test.mjs` | 37 assertions green over real HTTP: the virtual root, relative single-root backwards compatibility, and the refusals — traversal, out-of-root absolute paths, and reading outside every root |
| `test/setup.test.mjs` | 56 assertions green — the token-file fallback, the served page's own script, and that `/setup` answers 403 to anything that is not loopback |
| `test/questions.test.mjs` | 34 assertions green — the answer reaching the `user-questions/request` waterfall, a partial batch refused without resolving anything, a downstream refusal NOT ending the race, a desktop skip still counting as an answer, a question from another session still being shown, an abort ending the race rather than hanging, and an unchanged poll leaving the DOM alone so typing is not interrupted |
| `test/integration.test.mjs` | 58 assertions green against a real `node:http` server mounting the real panel: the auth guard covers the new asset, the routes are actually wired, the cookie bootstrap preserves the popup's `id`/`view` while dropping the token, the full handshake completes, and every inline script the phone is actually served parses |

653 assertions across thirteen suites, plus a standalone guard (`test/shell-guard.mjs`)
for the panel's single-template shell.

Still unverified: **how any of this renders on a real phone.** The server half of
the approval card, the permission dialog, the model picker, the context meter and
the file browser is proven; the browser half has never been seen on a device. The
panel installs `error` and `unhandledrejection` handlers that render into a
dismissable bar at the top of the page, because a silent JS failure on a phone is
otherwise indistinguishable from a button that does not exist.

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

### Answering a question from the phone

`ask_user_question` **parks the turn** until something answers. The desktop GUI is
one answerer; the panel is now another, in the same place an approval appears —
replacing the composer, because the turn is stopped and the answer belongs where
the reader's attention already is. Options render as buttons (toggling when the
question is `multiSelect`), each question also takes free text, and the whole
request is submitted as one batch.

The race is the approval race with one deliberate difference. A question travels
a **waterfall**, and the caller treats *any* rejection as "nobody could ask" — so
a downstream answerer that refuses (no desktop GUI attached, which is the normal
case for a phone-only deployment) must not settle the race while the phone is
still deciding. This race therefore resolves on the first **success**, and a
failure is only surfaced once both sides have failed:

```js
const lose = (error) => {
  if (error?.code === 'ASK_ABORTED') { fail(error); return }   // terminal for both
  if (++failed === 2) fail(firstFailure)
}
```

An **abort** is the exception, and it is terminal for both sides: once the caller
has given up, no answerer can help, and waiting for the other one would hang the
turn rather than end it. That case is a test, not a hope — the first version of
this code waited forever for a phone that was never going to answer.

**Questions are not filtered by session, and that asymmetry with approvals is
deliberate.** An approval that is not shown leaves the desktop prompt doing its
job; a question that is not shown leaves a **turn parked** with nothing on the
device to explain it. The card for another session carries a button to jump
there, so nothing is ambiguous — and a session id that fails to match for any
reason can no longer swallow the only surface that could have answered.

This is the fix for the first live failure of this feature: a question sat
pending on the host the whole time the user waited, and the phone never showed
it, because it was filed under a session the phone was not displaying. The user
eventually found it on the desktop and pressed **skip**.

Two consequences of that incident are worth keeping:

- **A skip is an answer.** It resolves with an all-blank batch, which the tool's
  contract permits. An earlier version of this code treated an entirely blank
  batch as "no human behind it" and refused to settle — which would have kept a
  turn parked on the phone forever after somebody deliberately skipped. The real
  fault was the hidden card, not the blank answer, and guessing at the answer was
  the wrong place to fix it.
- **The poll is guarded.** `renderSlots()` runs inside a `try`, because that loop
  is the only way a parked turn ever becomes visible; a render fault ending it
  would look exactly like "nothing is waiting". `/bridge/api/questions` also
  returns a short `recent` history — `offered`, `panel-answer`,
  `downstream-answer`, `aborted`, `failed` — plus `youAre`, the session the
  caller says it is showing, so a mismatch is readable rather than inferred.
- **An unchanged poll does not touch the DOM.** It only rebuilds when the set of
  things to show changed, because `replaceChildren` destroys the input the reader
  is typing in — which on a phone **dismisses the keyboard mid-word**. The
  in-place update inside a card is no defence against that: the poll is what
  rebuilds, not the card. A rebuild that does land (a new card arrived) carries
  the caret over, though that alone does not reliably reopen a phone keyboard;
  refusing the rebuild is what does.

A batch must answer **every** question it was given: a partial batch is refused
with a 400 and resolves nothing, because the tool's contract is one answer per
question and a hole there is worse than a retry.

Because the turn is parked, a question nobody hears about is a turn that never
finishes. That is why the listener is registered unconditionally rather than only
when some feature flag is on.

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
preset, the model and its reasoning effort, **上下文占用** and compacting,
**引用文件** (insert a path from this machine into the composer), and the two
scroll ends. These used to be header chips, which squeezed the conversation title
down to an ellipsis the moment there were two of them.

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

### Forking a conversation

Each row in the drawer carries a 分支 button. It cuts the conversation at its
**last completed turn** and creates a new session seeded with that prefix, then
opens it.

The recipe is mirrored from `dsh-api-session-controller`, which owns the canonical
version and cannot be imported here — the same three steps it takes: cut at a
completed turn boundary, create the child with `seed` + `inheritedEventCount` +
`meta.parentSession`, and attach it to a workspace, without which the desktop
sidebar never groups it at all.

**The cut is the part that matters**, so it lives in a pure exported function,
`planForkCut`, with its own tests. Only a completed turn is safe: seeding a child
with half an exchange gives it a request with no reply or a tool call with no
result, and the symptom appears much later as an agent confused about its own
history. The cut then advances to the next `turn/start`, so a title, a delivery
marker or a checkpoint logged after the last turn stays with the **source**. A test
found a real defect here: the cut was not clamped, and a `turn/end` can carry a seq
higher than its array position (a compaction replacement lands a fresh high-seq
node at an older position), which made the "exclusive index" a lie even though
`slice` forgave it.

**A fork does not inherit the source's sandbox.** A fork is a new session this
bridge created, so the configured `permissionPreset` is pinned before its first
tool call. Inheriting would let a wider preset propagate by duplication; the phone
can request a change on the child explicitly if it needs one. The child *does*
follow the source's **agent preset**, so a forked conversation keeps the
composition it was already having.

### Inserting a message without sending it

The composer has two buttons next to 发送, and they are not the same thing:

| Button | Boundary | What it does |
|---|---|---|
| 排队 | `next-turn` | Waits its turn. Safe, and the default. |
| 插话 | `next-step` | Steers the turn that is **already running**, at its next step. |

Both **insert without sending**: nothing wakes the driver, so the message sits in
the queue, visible in the tray above the input, until somebody sends it. Each tray
row carries 立即发送 / 编辑 / 撤销.

**"Syncs with the desktop" is not implemented here, and that is the point.**
`agent.inbox` is the same projection the desktop GUI reads, and every mutation it
exposes — `append`, `replace`, `remove` — is a durable `agent/inbox/spliced`
session event. The panel reads and writes that one list. A private queue inside
this plugin would have to be mirrored by hand and would drift the first time the
desktop changed something the phone could not see, so a test asserts the absence
of one, alongside the `agent.inbox` calls it uses instead.

**立即发送** removes the message from wherever it sits and re-sends it waking the
driver, which is what "send this now" means. It has to be that pair: the inbox
refuses a duplicate identity, and the harness exposes no bare "wake".

**Editing happens in place** so the reader keeps the queue position they chose, and
`replace` is what preserves it. The text being typed is deliberately **not** part
of the tray's rebuild key — the same discipline the question card needed after the
poll closed the keyboard mid-word.

A conversation with no live agent is refused with a 409 rather than silently
queueing, because a queue nobody can see is worse than an error.

### Watching a turn: folded thinking, copy, stop

**Thinking streams into a folded block.** It is built on the first
`reasoning-delta` and starts closed, above the reply. Lazily, because a turn that
streams text without ever reasoning must not show an empty fold claiming it
thought. The summary reads 思考（正在输出）while it is live and drops the
parenthetical when the turn ends.

Reasoning arrives on its **own callback** rather than a kind flag on one shared
callback, because the two callers want opposite things: the panel folds it into
the transcript, and the `/v1` face must drop it entirely. A chat client showing a
model's private reasoning as its answer is a leak, not a feature — and with a
shared callback that leak is a one-line mistake. A caller that passes nothing for
it gets it dropped, and a test asserts that exactly one call site takes it.

**Copy** exists on every message (the reply plus every folded block, because "copy
this message" should mean what is on screen) and on **every code block**, since
selecting a long block by hand on a touch screen is miserable.

It cannot use `navigator.clipboard`: that exists only in a secure context, and
this panel is served over plain http on a LAN address, so on a phone it is usually
absent. The fallback is the old textarea-and-`execCommand` selection, which it
must run **synchronously inside the click** — a programmatic copy needs the user
gesture that started it. And it reports what happened: a button claiming 已复制
when nothing reached the clipboard is worse than one that says 长按选择, because
the reader pastes and gets the previous contents.

**Stop** appears only while a turn is streaming, and it **keeps queued input**.
Stopping the output is not the same decision as discarding what you already
typed, so clearing the queue is a separate request. `agent.cancel` is a documented
no-op when nothing is running, so the reply reports the state observed *before*
the call rather than claiming a stop that did nothing.

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

### The per-client allowlist

The token is the only secret between the LAN and this machine, and a token that
travels in a URL — a bookmark, a screenshot, a chat message, a shared clipboard —
leaks silently. The allowlist makes that leak insufficient on its own: a peer that
has never been approved is refused **everything**, panel, OpenAI face and approval
console alike, until somebody at the machine reads a code off the loopback-only
setup page and types it on that device. A leaked token then buys an attacker
nothing until a human is standing at the computer.

Loopback never pairs, so the machine running DSH never has to approve itself.

**What it is not.** It is not a boundary against someone already on the LAN. ARP
spoofing can impersonate an approved address, DHCP hands a phone a new address
without asking, and a dual-stack or multi-homed device arrives under a different
spelling each time. Approving an address approves whoever can claim it. What this
defends against is the leaked token, and only that.

**The ordering is deliberate.** The check runs *after* the token check and
*before* every panel route including the slashless redirect. Serving the shell
first would hand an un-approved device the whole page and gate only its data. And
running it after the token means a pairing code is minted only for a device that
has already proved it holds a token — otherwise anyone who merely guessed the port
could put codes on the operator's screen.

**The code is never readable from the device being approved.** It appears only in
`/setup/state`, which is loopback-only, and never in the refusal the phone
receives. It is also never persisted: a code lives in memory for its TTL, while
the approval it produces is written to `$DSH_HOME/openai-bridge-clients.json`. A
restart clears every un-approved device and keeps every approved one.

**A wrong code is bounded in both directions.** Five attempts kill the code and
it stays dead for its TTL — and then the TTL expires the whole entry, so the
device's next request mints a fresh code. A lock that outlived its TTL would be a
permanent lockout with nothing on the setup page to explain it, because that page
only shows live entries. The setup page can also replace a code by hand, which is
the way back in when one has run out of attempts or was read aloud to the wrong
person: the replacement clears the lock and restarts the clock.

**The page opens itself.** A device that starts waiting opens the setup page on
this machine, because an operator should not have to be watching to find out that
somebody is trying to get in. That popup is the only thing a stranger can trigger
here, so it is rate-limited to one per `pairingPopupCooldownMs` and the waiting
list is capped — a sweep across the LAN opens one window and mints a handful of
codes, not one per address.

Devices are removed from the setup page, which rewrites the file immediately.

The code is deliberately never written to the host log, so the page is the only
place it appears — which would be a lockout with no way out if that page's script
ever failed. `http://127.0.0.1:<port>/setup/state` is the fallback: it is the same
loopback-only JSON the page reads, so the code is still reachable with no UI at
all. And `ipAllowlist: false` plus a restart turns the gate off entirely if
something about it is wrong.

### The context meter, and compacting from the phone

📊 in the cluster is the phone's copy of the ring beside the desktop's send
button, and it reads the same two session projections — `contextPressure` for the
occupancy and `contextBreakdown` for the system/tools/conversation split. Same
source, so the two surfaces cannot disagree about how full a context is. The
breakdown is a heuristic token estimate, which is why the three rows can sum to
something other than the headline figure; that is true on the desktop too.

**There is no cold read.** `ctx.sessionProjections.snapshot()` takes a `Session`
object and `ctx.sessions.get()` only returns attached ones, so a conversation the
process is not holding has no numbers at all. Opening the meter therefore reports
"not loaded" and stops there; a separate **读取占用** action attaches the session
first. Attaching deliberately does not start a turn, and because it runs this
bridge's `setup`, the conversation stays switchable from the phone afterwards.

Compaction calls the same `ctx.compaction.compactNow(agent, signal)` the desktop's
`/compact` command calls, so it produces an ordinary compaction: a summary node
the desktop renders as a checkpoint. `compaction-basic` is mounted twice in a
default composition — the base bundle inserts it as a host-plane row, and each
shipped agent preset mounts its own instance inside an isolated realm — so the
service is resolved per conversation: the agent's own preset realm first, then the
host row. The backend's own `ManualCompactionError` codes are folded into
sentences — `busy` becomes a 409 saying the conversation is mid-turn, and the rest
(a changed span, a failed summary, a failed save) keep their distinct wording
instead of collapsing into "error". An unrecognised code keeps its raw message,
because disguising an unexpected failure as a known one would hide a bug.
Compaction is two taps in the sheet, not a native `confirm()`, which is a silent
no-op in plenty of in-app webviews.

The module registers into the action cluster like the others, but with one
difference: if the cluster never arrives it renders a standalone button instead.
A script that fails to load must not take the meter down with it, and the
difference between "the cluster is broken" and "the meter is broken" is worth
being able to see from the phone.

## Backing it out

Remove `dsh-openai-bridge` from `dsh.profile.bundles` (and `dependencies`) in
the profile's `package.json`, then restart.
