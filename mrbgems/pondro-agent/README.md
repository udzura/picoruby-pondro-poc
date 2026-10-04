# Pondro::Agent

An optional single-event agent harness. Add `pondro-agent` to the build and declare
`use Pondro::Agent` alongside `use Pondro::Bindings`.

```ruby
class Assistant < Pondro::Object
  use Pondro::Bindings
  use Pondro::Agent
  state :memory, default: {}

  tool :remember, description: 'Remember a value', parameters: {
    'type' => 'object',
    'properties' => { 'key' => { 'type' => 'string' }, 'value' => { 'type' => 'string' } },
    'required' => ['key', 'value'], 'additionalProperties' => false
  }

  def remember(args)
    memory[args['key']] = args['value']
    { 'saved' => true }
  end

  rpc :respond
  def respond(text)
    result = run!(bindings.AI, '@cf/meta/llama-3.1-8b-instruct-fp8',
                  input: text, max_steps: 8, options: { 'max_tokens' => 512 })
    result['text']
  end
end
```

`tool` names correspond to Ruby method names. Each method receives one validated
arguments Hash and returns a JSON-serializable value. Tool registration does not
export RPC or HTTP methods. Definitions are inherited; a subclass may redefine a
tool. There is no `memory` or `agent_model` DSL. Memory policy and persistence use
ordinary `state` declarations and application methods.

`input:` accepts text or a messages array, which is copied before use. `options:`
is forwarded to the model; messages and registered tools are owned by the loop.
The result contains `text` (the final response), `messages` (the complete run
transcript), and `steps` (model-call count). The transcript is returned, not
implicitly persisted. Store it in state if needed; keep conversation history
bounded in the application.

`max_steps` includes the final model call. Tools execute serially; the last
permitted call cannot start another tool round. An unknown tool, invalid
arguments, provider error, empty response, tool failure or exhausted limit raises
an exception. There is no automatic retry. Each step permits at most 16 tool
calls. Input is limited to 256 KiB, response and each tool result to 64 KiB.

The supported schema vocabulary is `type`, `description`, `properties`,
`required`, `additionalProperties` (boolean), `items`, and `enum`. Types are
object, array, string, integer, number, boolean and null. This is a small subset
of JSON Schema; unsupported keywords are rejected at declaration. Required
arguments and types are checked before any tools in that round execute.

## Response helpers

The loop does not assume SSE. `helper:` owns model invocation, decoding and the
provider's tool-result message format:

- `complete(binding, model, input) { |text_delta| ... }` returns a Hash with
  `content` and `tool_calls`. Each call has `name`, `arguments` (Hash or JSON
  string), and optionally `id`.
- `append(messages, response, results)` appends the assistant's requests and tool
  responses. Each result has `call` and JSON-encoded `content`.

The default `Pondro::Agent::WorkersAI` uses `binding.run` with `stream: false`.
It reads Workers AI JSON responses and OpenAI-shaped `choices[].message`, and
preserves call IDs when present. Tools use Workers AI's native declarations.
See the [traditional function-calling API](https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/).
Model support for tools and follow-up messages must be checked for the selected
model; this harness does not infer capabilities from model names.

`helper: Pondro::Agent::SSE` uses `binding.stream!(:run, ...)`, reads SSE data
frames, and assembles OpenAI-shaped tool argument fragments by index. Complete
native `tool_calls` frames are also accepted. Streams are closed on success and
failure; a stream is limited to 256 KiB. Tools run after the whole response is
read, not while argument fragments arrive. Choose it only for models that
support streamed tool calls. A custom helper can instead read NDJSON or any
other stream and convert it to the same response shape. It may also translate
tool definitions and messages to another provider's format.

The optional block receives text deltas from every round, including intermediate
assistant text. The returned `text` is only the final round's text.

## Event lifetime

A run finishes within the current Pondro event. State commits follow the normal
host rules: an uncaught event failure discards local state; caught failures can
retain application mutations. External tool effects are not rolled back with
local state. Future and stream handles cannot be stored for subsequent events.
No execution checkpoint, background scheduler, parallel agents or durable retry
is provided.
