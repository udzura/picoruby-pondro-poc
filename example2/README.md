# Example 2: shared AI chat

[日本語](README.ja.md)

Humans and AIs share a WebSocket chat. One AI ID has one saved personality and
can join multiple rooms; each room has independent history. The vanilla JS UI
is at `/example2/`.

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

## Run

From the repository root, after `npm ci` and `npm run setup`:

```sh
npm run build
npm run dev:example2:mock
```

Open <http://localhost:8787/example2/?admin=1> to create and invite AIs. Mock AI echoes the personality and latest
message, using local DOs and no remote inference. The UI labels this mode clearly.

The language selector switches between Japanese and English without reconnecting
or changing messages or personality prompts. Its preference is saved in the browser;
the initial language follows the browser language.
Share `/example2/` with demo participants: without `admin=1`, AI settings and
creation/invitation controls are disabled, while joining rooms and chatting work
normally. This is a UI-only switch, not server-side authorization; the API and
participant removal are unchanged.

The admin **Clear all demo data** button asks for confirmation, then disconnects
users and deletes storage for every PONDRO in this Worker: AI, catalog, all rooms,
history and counters, including human-only rooms. Active events finish before
deletion. IDs can then be reused. Language preferences and Cloudflare credentials
are retained. POST `/api/demo/reset?admin=1` is the demo reset endpoint; the query
is not authentication. A `DemoAdmin` DO persists an inventory of objects used by
HTTP, WebSocket and internal RPC. Objects predating this feature must be accessed
once to enter the inventory. External KV, D1 and R2 binding data is not deleted.

1. Enter a Room ID and your name, then connect.
2. Enter an AI ID, name, and personality prompt. Click **Load or create AI**.
   Select a saved AI from the list to load its original name and personality.
   Use **Refresh list** to see AI created in another browser.
3. Click **Invite AI to this room**, then send a message.
4. Open another tab in the same room to join as another human.
5. Join a different room, load the same AI ID, and invite it there too.

The first configuration of an AI ID wins. Existing IDs restore the saved name
and prompt; use a new ID for a different personality. A room supports up to four
AIs, each responding once per human message, in invitation order.
Use **Remove** on an AI's participant chip to remove it from the current room.
Its personality, other rooms and existing messages remain available, and it can
be invited again. Removal is disabled while an AI response is in progress.
Human connections and new AI invitations broadcast a join notice to everyone in
that room, including the joining human. Re-inviting an AI already in the room
does not repeat the notice. Notices follow the UI language and are not saved as
chat history or sent to the model.

For real inference, authenticate Wrangler with Cloudflare and run:

```sh
npm run dev:example2
```

`wrangler.jsonc` in this directory configures a remote AI binding. Inference uses
Workers AI even though the Worker and DOs run locally, and counts toward usage.
The model is `@cf/meta/llama-3.1-8b-instruct-fp8` with streaming and `max_tokens: 512`.
See [binding configuration](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
and [model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/).
Automated tests never run real inference.

## Design

| Object | Responsibility |
| --- | --- |
| `AICatalog['default']` | Durable list of created AI IDs and display names |
| `AIParticipant[ai_id]` | Durable name, initial personality, joined Room IDs |
| `AIChatRoom[room_id]` | Durable AI roster, history, WebSocket broadcasts |

Both use the existing PONDRO namespace with distinct `[class, id]` identities.
The optional `mrbgems/pondro-example2` mgem contains the app and an SSE parser;
Pondro core APIs are unchanged. The Room reads an AI profile through internal
RPC, then performs inference with its own history. Keeping inference in the
Room avoids holding the shared AI's event queue throughout generation, allowing
different rooms to respond concurrently without mixing conversations.
Creation registers each AI in the catalog; `load` also repairs its registration.
For AI created before the catalog existed, load the known ID once to index it.
Catalog and AI persistence are not a distributed transaction.
POST `/api/AICatalog/default` with `{"method":"list"}` returns the ID/name list.
`AIParticipant.load` returns the saved profile or `null` for unconfigured AI.

```ruby
profile = AIParticipant[ai_id].profile.await
stream = bindings.AI.stream!(:generate, profile['model'], input)
Pondro::Example2::SSE.each_delta(stream) do |delta|
  # Broadcast using socket.send_now(...).await.
end
stream.close
```

The last 20 entries provide model context, and the last 50 complete messages
are saved. Only the current AI's previous replies use the assistant role;
other participants' names appear in user content. SSE supports Workers AI
`response` and OpenAI-style `choices[0].delta.content`, CRLF, multiline data,
split UTF-8, and `[DONE]`. Deltas reach all human sockets before completion.
AI failures preserve the human message, mark the live reply interrupted, release
the stream, and permit the next turn. One disconnected client does not stop others.

## Protocol and limits

Connect to `/ws/AIChatRoom/<room_id>?name=<display_name>` and send
`{"type":"invite","ai_id":"sage"}`, `{"type":"remove","ai_id":"sage"}`
or `{"type":"say","text":"Hello!"}`.
Events: `welcome`, `participants`, `message`, `ai_start`, `ai_delta`, `ai_error`,
`ready`, `notice`, `error`. A message's `sequence` is unique within its room.
POST `/api/AIParticipant/<ai_id>` accepts
`{"method":"configure","args":["Sage","Be a curious botanist."]}` and
`{"method":"profile"}`. The `join`, `leave` and Room `history` RPCs are internal only.

This is an unauthenticated local PoC. Limits: 4096-byte personality,
2000-byte human message, 16 KiB AI reply, 256 KiB SSE input per reply,
100 rooms per AI. Turns within a room are serialized. Futures/streams are
event-local. History commits at event completion, so live deltas are best effort
and can precede storage. AI membership and Room state are not a distributed
transaction.

## Verify

```sh
npm test
npm run test:ruby
npm run test:e2e
npm run test:example2:e2e
```

Real-Wasm tests cover concurrent rooms sharing one AI, immutable personality,
room isolation, streaming, error recovery and storage restoration. The workerd
test uses mock AI for real WebSockets, invitations, UTF-8, departure and restart.
