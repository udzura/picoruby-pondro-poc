# PicoRuby PONDRO PoC

[日本語](README.ja.md)

PONDRO (**Plain Old Durable Ruby Object**) maps a Ruby object to a Cloudflare
Durable Object. This repository runs real PicoRuby bytecode in Wasm, with a
plain durable `Counter` and a `ChatRoom` that opts into WebSocket events.
It does not depend on picoruby-cloudflare-worker-wasm or another Worker framework.

## Run locally

Requirements: Ruby with `rake`, Node.js with WebAssembly JSPI support
(`WebAssembly.Suspending` and `WebAssembly.promising`), and Emscripten (`emcc`,
`emar`) on `PATH`. Verified with Node.js 26.8.1, Emscripten 6.0.9, and the
workerd version installed by the locked Wrangler dependency.

```sh
npm ci
npm run setup
npm run build
npm run dev
```

Open http://localhost:8787. Use the counter buttons and connect to a room.
Open another tab in the same room to receive broadcasts. Different room IDs
have separate state and connections. Reconnect to receive the last 50 messages.

The chat has separate Room ID and Counter ID fields. The first connection
binds a room to that Counter ID and saves the association; other clients in
that room must use the same Counter ID. Each valid message increments that
separate Counter PONDRO once. The total appears at the bottom right of the chat,
including on reconnect. Connect/disconnect notices do not increment it.
Different rooms can share a Counter ID for a combined total; the frontend also
refreshes the total every three seconds while connected to reflect other rooms.

`setup` checks out PicoRuby revision
`65b7ae6256faa2e53aa0cf8249c8ad5f1cd86327` in the ignored `vendor/` directory
and initializes only the compiler/VM submodules needed for this build.
`build` produces `dist/pondro.wasm`; rebuild after editing Ruby or C.
Wrangler watches the JS, frontend and Wasm. Its local storage is under `.wrangler/`.

If your global npm or Emscripten cache is not writable, use a writable cache
directory (for example `npm ci --cache /tmp/pondro-npm-cache` or
`EM_CACHE=/tmp/pondro-em-cache npm run build`).

## Ruby objects

```ruby
class Counter < Pondro::Object
  state :count, default: 0
  rpc :increment, :value, http: true

  def increment
    self.count += 1
  end

  def value
    count
  end
end

class ChatRoom < Pondro::Object
  use Pondro::WebSocket
  state :messages, default: []

  def on_message(socket, message)
    messages << message
    sockets.each { |client| client.send(message) }
  end
end

Pondro.register('Counter', Counter)
Pondro.register('ChatRoom', ChatRoom)
```

The actual example adds a durable sequence, bounded history, a welcome message,
an awaited remote Counter increment, and JSON messages for the frontend. See
[`mrbgems/pondro-example/mrblib/app.rb`](mrbgems/pondro-example/mrblib/app.rb).

`state` creates a getter and setter. Its value must be JSON serializable.
Array/hash changes such as `messages << entry` are included in the next snapshot.
Defaults are deep copied for each event, and state/RPC/adapter declarations are
inherited by subclasses. `rpc :history` exports a method to Ruby references and
Worker JS RPC, with HTTP access disabled by default. Use `rpc :increment, http: true`
to also allow HTTP calls. Multiple methods can share the option:
`rpc :increment, :value, http: true`. Subclasses can redeclare a method with
`http: false` to disable inherited HTTP access. HTTP requests cannot override
this policy through their JSON payload; denied methods return 403.
Internal methods such as `send` and `initialize` are not exported.

`use Pondro::WebSocket` adds `on_connect(socket)`, `on_message(socket, text)`,
`on_close(socket, code, reason)` and `on_error(socket)`. `sockets` returns current
connection proxies. A `Pondro::Socket` exposes `id`, `send(text)` and
`close(code = 1000, reason = '')`. It stores a connection ID and an event-local
effect buffer, never a JS WebSocket. Do not persist a Socket in `state`.

## Adopted design

The final part of the referenced **Rubyエージェント構成設計** conversation proposed
identity/state/dispatch as the core and optional event adapters. This PoC adopts
that boundary on both sides of Wasm:

| Component | Responsibility |
| --- | --- |
| `mrbgems/pondro-core` | `Pondro::Object`, identity, state DSL, RPC allowlist, class registry, generic event dispatch |
| `mrbgems/pondro-websocket` | Opt-in Ruby callbacks and connection-ID proxies |
| `mrbgems/pondro-rpc` | Remote object references and awaitable Futures |
| `mrbgems/pondro-wasm` | C ABI, JSPI RPC imports and an event-driven task HAL for PicoRuby |
| `mrbgems/pondro-example` | Plain Counter and WebSocket ChatRoom |
| `worker/runtime.js` | Wasm instantiation and UTF-8 JSON/memory handling |
| `worker/host.js` | State restore/commit and generic adapter effects |
| `worker/adapters/websocket.js` | Cloudflare upgrade, hibernation attachments and socket delivery |
| `worker/index.js` | HTTP routing and Durable Object lifecycle hooks |
| `public/` | Vanilla JS demo frontend |

The build config loads the local directories as mgems. `pondro-core` has no
WebSocket dependency. A core-only application can omit `pondro-websocket` and
replace `pondro-example` with its own application mgem. Remote references can
also be omitted by leaving out `pondro-rpc`. This demo links all three.
The JS upgrade adapter queries Ruby capabilities, so Ruby's `use` declaration
determines whether an object accepts WebSocket connections.

Object identity is `(Ruby class name, user-provided ID)`, encoded unambiguously
for `idFromName`. One exported JS Durable Object class serves multiple Ruby
classes and identities. Each active Durable Object owns one Wasm instance/VM;
the compiled Wasm module is imported once. The initial linear memory is 2 MiB,
grows on demand, and is capped at 32 MiB per instance. This is a memory setting,
not a measurement of the total cost of an activation.

The C ABI is `pondro_init()`, `pondro_dispatch(json)` and `pondro_destroy()`.
The JSON dispatch envelope carries `class`, `id`, `state`, `type`, `payload`
and adapter `context`. Ruby returns `value`, the new `state` and `effects`.
For example, `websocket.message` becomes `ChatRoom#on_message`.

Each event restores an object from its declared defaults and durable snapshot.
Handlers may suspend at `Future#await`. A host queue serializes events within
each Durable Object, preventing VM re-entry and lost snapshot updates. The
host restores state when an event reaches the front of that queue, executes
Ruby outside a storage transaction, and commits the returned snapshot in a
short synchronous SQLite transaction before applying socket effects. No storage
transaction spans a remote await. Failed Ruby events have no committed local
state or socket effects. Ordinary instance variables are
event-local; only declared `state` survives another event or activation.
Keeping the VM alive does not make Ruby heap objects durable.

## Remote objects and Future.await

```ruby
class ChatRoom < Pondro::Object
  use Pondro::WebSocket

  def on_message(socket, message)
    pending = Counter[id].increment
    # The remote call has started; synchronous Ruby work can happen here.
    count = pending.await
    socket.send("Message count: #{count}")
  rescue Pondro::RemoteError => error
    socket.send("Counter failed: #{error.message}")
  end
end
```

`Counter[id]` returns a reference to a separate durable Counter with the given
ID. Calling an exported method starts a remote call immediately and returns a
`Pondro::Future`. `pending.await` suspends the current Ruby/Wasm execution,
without blocking JavaScript, until the call settles. `pending.read` is an alias.
Repeated await/read returns the cached value or raises the same cached
`Pondro::RemoteError`; it does not issue another RPC. Futures are event-local,
not durable tasks: do not save them in `state`.

The C bridge imports a synchronous `pondro.rpc_start` and a suspending
`pondro.rpc_await`. JS starts the Durable Object stub's `invoke` RPC and retains
its Promise under a token. `WebAssembly.Suspending` wraps the await import and
`WebAssembly.promising` wraps the dispatch export, preserving the Ruby/C/Wasm
stack while the Promise resolves. These wrappers are supplied by our standalone
JS runtime; no generated Emscripten JS runtime or JSPI transform is required.
See the [WebAssembly JSPI proposal](https://github.com/WebAssembly/js-promise-integration)
and [Emscripten async documentation](https://emscripten.org/docs/porting/asyncify.html).

Even Futures that are never awaited are drained before an event completes.
Their remote failures are handled to prevent unhandled JS rejections, but only
await/read exposes those failures to Ruby. A pending event keeps its VM active;
this is not a checkpoint that survives hibernation or a restart.

The demo calls `Counter[counter_id].increment.await` for each valid message.
Its returned `count` is included in broadcasts and history and displayed as
Total messages in the chat footer. You can inspect that same Counter through
`/api/Counter/<counter_id>`.

Transactions are local to each object. A Counter increment that succeeds is
not rolled back if ChatRoom subsequently fails. There are no automatic retries
or exactly-once guarantees. Call chains reject self-calls and cycles within
the propagated chain and are limited to 16 objects. Remote calls have a
10-second timeout, also bounding independently initiated wait cycles between
busy objects. Timeout does not cancel a remote operation: it may still complete
and change remote state. The demo's JS resolver supports Counter and ChatRoom;
adding another Ruby class also requires adding it to the JS routing/resolver.

The JS adapter uses Cloudflare's hibernation API (`acceptWebSocket`,
`getWebSockets`, `serializeAttachment`, `deserializeAttachment`). Connection
IDs and object identity live in attachments, so callbacks can reconstruct Ruby
proxies after activation without an in-memory socket map. See the official
[WebSocket hibernation documentation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Endpoints

```sh
curl -X POST http://localhost:8787/api/Counter/demo \
  -H 'Content-Type: application/json' \
  -d '{"method":"increment","args":[]}'
# {"value":1}

curl -X POST http://localhost:8787/api/ChatRoom/lobby \
  -H 'Content-Type: application/json' \
  -d '{"method":"history"}'
# HTTP 403: history is exported only through internal RPC
```

Connect a WebSocket to `/ws/ChatRoom/lobby?counter_id=message-total` and send plain text.
Omitting `counter_id` defaults to the Room ID. The server sends
JSON `welcome` and `message` events. `/ws/Counter/demo` rejects upgrades because
Counter does not use the WebSocket adapter.

When a client disconnects, `ChatRoom#on_close` broadcasts a JSON `left` event
to the remaining clients in that room. The frontend displays “left the room”.
Departure notices are transient and are not saved in chat history.

## Verification

```sh
npm run test:ruby
npm test
npm run test:e2e
```

* CRuby tests load core without the WebSocket mgem and cover inheritance,
  independent mutable defaults, explicit RPC exports and exception handling.
  Future tests cover eager start, cached await/read and cached remote errors.
* Node tests instantiate the built PicoRuby Wasm and cover VM isolation,
  snapshot restore, Unicode, history trimming, adapter opt-in, failed events,
  persistence before effects, and proxies after constructing a fresh VM.
  They exercise real JSPI suspension, remote failure/recovery, serialized
  concurrent events, VM re-entry rejection and cycle rejection.
* The workerd end-to-end test starts Wrangler on a random loopback port with
  temporary storage. It exercises concurrent counter increments, two-client
  broadcasts, room isolation, Unicode, invalid RPC/upgrade/body/binary input,
  Future.await from ChatRoom to a separate Counter Durable Object, departure
  broadcasts, and both objects' persistence after stopping and restarting.
  It cleans up the server and temporary state.

## PoC boundaries

The sample is unauthenticated. HTTP is a JS adapter with two named sample
classes, not a general Rack implementation or arbitrary remote Ruby execution.
Messages are text-only, limited to 4096 UTF-8 bytes; RPC bodies are limited to
8192 bytes. Chat history retains 50 entries.

Socket delivery after state commit is best effort, not an atomic durable outbox
or exactly-once delivery. A committed message may need to be recovered from
history after a disconnect. There are no alarms, queues, workflows or
asynchronous Ruby Task scheduling in this PoC; external RPC awaits use JSPI.

The hibernation-compatible callback/attachment path is implemented. Tests cover
fresh-VM reconstruction and a local server restart; actual Cloudflare idle
hibernation with live connections and production memory usage require a deployed
environment and have not been measured. No deployment is performed by setup,
build or tests.
