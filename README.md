# PicoRuby PONDRO PoC

[日本語](README.ja.md)

PONDRO (**Plain Old Durable Ruby Object**) maps a Ruby object to a Cloudflare
Durable Object. This repository runs real PicoRuby bytecode in Wasm, with a
plain durable `Counter` and a `ChatRoom` that opts into WebSocket events.
It does not depend on picoruby-cloudflare-worker-wasm or another Worker framework.

[Example 2](example2/README.md) adds shared AI personalities and WebSocket chat.
Use `npm run dev:example2:mock` for an offline demo or `npm run dev:example2`
for Workers AI, then open `/example2/`.

## Basic authentication

Static assets, HTTP APIs and WebSocket handshakes all require Basic authentication.
Set the `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` secrets. Missing or empty secrets
return 503; invalid credentials return 401. The username cannot contain a colon;
passwords can.

For local development, create `.dev.vars` beside the Wrangler configuration:
`.dev.vars` for the root Worker or `example2/.dev.vars` for either Example 2 config.
These files are ignored by Git.

```dotenv
BASIC_AUTH_USER="demo"
BASIC_AUTH_PASSWORD="replace-with-your-password"
```

Set deployed secrets through the Cloudflare dashboard or the commands below.
Use the root config instead when deploying the root Worker. `wrangler secret put`
updates the deployed Worker, so run these commands when publishing.

```sh
npx wrangler secret put BASIC_AUTH_USER --config example2/wrangler.jsonc
npx wrangler secret put BASIC_AUTH_PASSWORD --config example2/wrangler.jsonc
```

After the browser login, credentials are sent with same-site asset, API and
WebSocket requests. `admin=1` still enables the demo management UI after login.
All assets pass through the Worker using `assets.run_worker_first: true`.
See the official [secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
and [asset routing documentation](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

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
| `mrbgems/pondro-async` | Event-local eager Futures, shared by RPC and binding calls |
| `mrbgems/pondro-rpc` | Remote object references |
| `mrbgems/pondro-bindings` | Synchronous binding proxies, explicit async calls and read-only StreamFutures |
| `mrbgems/pondro-wasm` | C ABI, JSPI async imports and an event-driven task HAL for PicoRuby |
| `mrbgems/pondro-example` | Plain Counter and WebSocket ChatRoom |
| `mrbgems/pondro-example2` | Shared AI personalities and streaming WebSocket chat rooms |
| `worker/runtime.js` | Wasm instantiation and UTF-8 JSON/memory handling |
| `worker/host.js` | State restore/commit and generic adapter effects |
| `worker/adapters/websocket.js` | Cloudflare upgrade, hibernation attachments and socket delivery |
| `worker/adapters/bindings.js` | Connects Pondro Futures to the existing Cloudflare host dispatcher |
| `worker/upstream/` | Unmodified, pinned Worker host codec/dispatcher and MIT license |
| `worker/index.js` | HTTP routing and Durable Object lifecycle hooks |
| `public/` | Vanilla JS demo frontend |

The build config loads the local directories as mgems. `pondro-core` has no
WebSocket dependency. A core-only application can omit `pondro-websocket` and
replace `pondro-example` and `pondro-example2` with its own application mgem. Remote references can
also be omitted by leaving out `pondro-rpc`. Binding access is optional through
`pondro-bindings`; both use `pondro-async`. This demo links all of them.
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

The C bridge imports a synchronous `pondro.async_start` and a suspending
`pondro.async_await`. JS starts the Durable Object stub's `invoke` RPC and retains
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
and change remote state. The demo's JS resolver supports Counter, ChatRoom, BindingProbe, StreamProbe, GenericProbe, AICatalog, AIParticipant and AIChatRoom;
adding another Ruby class also requires adding it to the JS routing/resolver.

The JS adapter uses Cloudflare's hibernation API (`acceptWebSocket`,
`getWebSockets`, `serializeAttachment`, `deserializeAttachment`). Connection
IDs and object identity live in attachments, so callbacks can reconstruct Ruby
proxies after activation without an in-memory socket map. See the official
[WebSocket hibernation documentation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Other Cloudflare bindings

The integration reuses the host-call codec and dispatcher from
[picoruby-cloudflare-worker-wasm](https://github.com/udzura/picoruby-cloudflare-worker-wasm).
`worker/upstream/source.json` pins revision `63e2611d9c56d046ebcfd5b83837cdecaed060ba`
and SHA-256 checksums. The JS sources are copied without modification, with their
MIT license; `npm run sync:bridge` retrieves and verifies the pinned snapshot.
No Emscripten-generated JS, Rack lifecycle or upstream C runtime is loaded.

```ruby
class MyObject < Pondro::Object
  use Pondro::Bindings

  def load_profile(user_id)
    cached = bindings[:CACHE].async!(:get, user_id)
    stored = bindings[:DB].prepare('SELECT body FROM pondro_notes WHERE id = ?')
                         .bind(user_id).async!(:first, 'body')
    { 'kv' => cached.await, 'd1' => stored.await }
  rescue Pondro::BindingError => error
    { 'error' => error.message }
  end
end
```

Ordinary binding calls wait for the operation and return its result. Use
`async!(:method, *args, **options)` to start immediately and return a
`Pondro::Future`; `await` returns the cached result or raises the cached error.
Only Ruby/Wasm execution waits: JSPI suspends it while JavaScript handles the
operation. This convention applies to resource bindings; DO references and
`socket.send_now` keep their existing Future API.
For older binding code, drop the trailing `.await` to use the synchronous result,
or change the call to `async!(:method, ...)` to retain an explicit Future.

KV `get` and `put(key, text, ttl: nil)` return values directly. Missing values return
`nil`, empty values return `''`, and writes return `nil`. This adapter supports
UTF-8 text only; invalid UTF-8 results fail rather than replacing bytes.
D1 uses explicit `prepare` and immutable `bind` statements with `run`, `first`
(optional column) and `raw(column_names: false)`, each returning a value directly.
Statements support `async!(:run)`, `async!(:first, column)` and
`async!(:raw, column_names: true)`; `prepare` and `bind` remain local operations.
The shared dispatcher checks arguments, TTL, scalar parameters, binding types
and errors. Failures raise `Pondro::BindingError` at the ordinary call, or on
await for an explicit async call.

`worker/index.js` passes an explicit registry (`CACHE: 'kv', DB: 'd1', BUCKET: 'r2', AI: 'ai'`) to the
adapter and exposes it as Ruby proxy metadata. The adapter allows KV get/put, D1 execution, R2 get, AI run and read-only stream
operations. The typed R2 proxy exposes reads only. Add real KV/D1
resource IDs to `wrangler.jsonc` before deployment; the included IDs are local
demo placeholders. Setup and tests do not create Cloudflare resources.

The `BindingProbe` sample creates a D1 table and writes a note into D1 and KV:

```sh
curl -X POST http://localhost:8787/api/BindingProbe/note \
  -H 'Content-Type: application/json' \
  -d '{"method":"store_note","args":["hello bindings"]}'
# {"value":{"kv":"hello bindings","d1":"hello bindings"}}
```

Call `read_note` afterward to read both stores; run `store_note` first to create
the table. External binding effects do not roll back with the local DO snapshot,
and writes across KV/D1 are not atomic. Local KV tests permit immediate reads;
production KV consistency may return a previous value after a write.
A shared upstream mgem extraction remains future work; the dependency is currently
a reproducible JS snapshot. Readable streams are owned by the current event.

## Generic binding calls

For a binding without a typed Ruby proxy, add its name as `generic` to the
registry passed to `BindingAdapter`, for example `{ SERVICE: 'generic' }`.
Configure the actual binding in Wrangler as well. Existing typed entries can
remain in the same registry.

```ruby
result = bindings.SERVICE.someMethod('hello', limit: 10)
# Calls env.SERVICE.someMethod('hello', { limit: 10 }) in JS and waits.

pending = bindings.SERVICE.async!(:someMethod, 'hello', limit: 10)
result = pending.await

result = bindings[:SERVICE].invoke(:someMethod, 'hello')
```

Method names and positional arguments are forwarded directly, preserving the JS
receiver. Ruby keyword arguments become a final options object. Arguments and
results must be JSON values: nested objects/arrays, strings, finite numbers
(integers within JS's safe range), booleans and null. JS `undefined` returns Ruby
`nil`. Response, Date, ArrayBuffer, streams and other special objects are rejected;
there is no generic stream or chained resource support. JS exceptions, missing
methods and registered bindings absent from `env` raise `Pondro::BindingError`
at the call, or when an explicit Future is awaited. Unregistered names fail at Ruby lookup. Use `invoke` when a remote
method name collides with a Ruby method; constructor/prototype methods are blocked.

`GenericProbe#call_service` exercises this path through internal RPC and is not
exported over HTTP. It requires a configured generic binding. Generic calls can
perform any supported method on that binding, so register the names you intend
to expose to Ruby.

## Reading R2 and AI streams

Registered bindings also support dot access: `bindings.AI` is equivalent to
`bindings[:AI]`. Existing Ruby method names still require `[]` access.

```ruby
object = bindings[:BUCKET].get('sample')
stream = object.body # nil when the object has no body; get returns nil if missing

while (line = stream.readline)
  socket.send_now(line).await
end

result = bindings.AI.generate(model, { 'prompt' => 'hello' })
pending = bindings.AI.async!(:generate, model, { 'prompt' => 'hello' })
result = pending.await

ai_stream = bindings.AI.stream!(:generate, model, { 'prompt' => 'hello' })
chunk = ai_stream.read_partial(1024)
rest = ai_stream.read_all(max_bytes: 65_536)
ai_stream.close

object = bindings.BUCKET.async!(:get, 'sample').await
text = object.body.read_all
```

R2 `get` waits for the object and exposes `metadata` and a ready
`Pondro::StreamFuture` as `body`; it does not consume the body. Missing objects
return `nil`, and objects without a body expose `nil`. Async R2 get returns a
regular Future whose awaited result has the same shape.

AI `run` is model-agnostic, and ordinary `generate` returns JSON. `stream!(:run, ...)`
and `stream!(:generate, ...)` force `stream: true` and return an eager
`Pondro::StreamFuture`. Its `await` waits only for the stream to open and returns
itself; it never consumes the body. Read methods wait for readiness automatically
and return strings directly. Repeated await does not reopen the stream, and reads
advance one shared cursor. Regular Futures provide `await`/`read` only.
Stream reads now return strings directly, so remove the old trailing `.await`
from `read_partial`, `readline`, `read_all` and `close` calls.
An explicit `stream: true` on ordinary `generate` still returns a ready
StreamFuture, but `stream!` is the dedicated streaming entry point.
Generic bindings remain JSON-only and do not support streaming.
The sample registry includes AI, but `wrangler.jsonc` leaves the AI resource
unconfigured. Add the appropriate AI binding to use a real model; tests use a
mock AI binding and do not call paid or remote inference.

| Read operation | Result |
| --- | --- |
| `read_partial(n)` | Available bytes up to n; does not wait to fill n; nil at EOF |
| `readline(max_bytes: 1_048_576)` | Includes newline; preserves CRLF and blank lines; returns the final unterminated line; nil at EOF |
| `read_all(max_bytes: 1_048_576)` | All remaining bytes; empty string at EOF; fails and cancels on overflow |
| `close` | Cancels and releases the source; safe to repeat |

All read limits are capped at 1 MiB; `read_partial` needs a positive integer.
Reads on the same stream are serialized and share leftover bytes. Lines and
chunks are binary Ruby strings: byte arrays cross the existing JSON/Future ABI,
then `mruby-pack` reconstructs the bytes without UTF-8 decoding or replacement.
Only send text once complete UTF-8 has been assembled. AI streaming bytes are
raw output (typically SSE), not parsed generation tokens.

The host cancels unread streams after each event, including failed events and
unawaited eager opens. Opens finish first; unawaited pending reads are canceled
before joining their Futures, so cleanup does not wait forever for incoming data. Handles never survive to the next event and must not be
saved in state. Source errors propagate as `Pondro::BindingError`.
The unchanged upstream dispatcher validates R2/AI and produces stream descriptors;
a per-call wrapper captures the actual source for Pondro's event-owned read
registry. Workerd's native R2 metadata is normalized before JSON validation.

`socket.send_now(text).await` opts into immediate delivery during the event.
It cannot be rolled back if later work fails. Existing `socket.send` remains
buffered until the state commit. The `StreamProbe` sample reads R2 lines over
`/ws/StreamProbe/<id>`: send an object key and receive `line` JSON events followed
by `done`. Its HTTP `read_object` method returns byte arrays, including non-UTF-8
bytes. No stream write or R2 put API is added.

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
  KV/D1 access through the reused bridge, R2 stream reads and WebSocket line
  delivery, binding persistence after restart,
  Future.await from ChatRoom to a separate Counter Durable Object, departure
  broadcasts, and both objects' persistence after stopping and restarting.
  It cleans up the server and temporary state.

## PoC boundaries

The sample is unauthenticated. HTTP is a JS adapter with four named sample
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
