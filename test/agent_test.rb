require 'json'
require 'minitest/autorun'
require_relative '../mrbgems/pondro-core/mrblib/pondro'
require_relative '../mrbgems/pondro-agent/mrblib/agent'
require_relative '../mrbgems/pondro-agent/mrblib/helpers'

class TestAgent < Pondro::Object
  use Pondro::Agent
  state :memory, default: {}
  tool :remember, description: 'Save a value', parameters: {
    'type' => 'object', 'properties' => { 'value' => { 'type' => 'string' } },
    'required' => ['value'], 'additionalProperties' => false
  }
  def remember(args)
    memory['value'] = args['value']
    { 'saved' => true }
  end
end
class ChildAgent < TestAgent; end

class AgentTest < Minitest::Test
  class Binding
    attr_reader :inputs
    def initialize(*responses)
      @responses = responses
      @inputs = []
    end
    def run(model, input)
      @inputs << JSON.parse(JSON.generate(input))
      @responses.shift
    end
  end
  class Stream
    attr_reader :closed
    def initialize(text)
      @lines = text.lines
    end
    def readline(max_bytes:)
      @lines.shift
    end
    def close
      @closed = true
    end
  end
  def agent
    @agent ||= ChildAgent.new('test', {}, {})
  end
  def call(name = 'remember', args = { 'value' => 'blue' })
    { 'name' => name, 'arguments' => args }
  end
  def test_json_tool_loop_inheritance_and_caller_owned_memory
    input = [{ 'role' => 'user', 'content' => 'Remember blue' }]
    binding = Binding.new({ 'tool_calls' => [call] }, { 'response' => 'Saved.' })
    result = agent.run!(binding, 'test', input: input)
    assert_equal 'Saved.', result['text']
    assert_equal 2, result['steps']
    assert_equal 'blue', agent.memory['value']
    assert_equal input, [{ 'role' => 'user', 'content' => 'Remember blue' }]
    assert_equal ['user', 'assistant', 'tool'], binding.inputs.last['messages'].map { |message| message['role'] }
    assert_equal({ 'saved' => true }, JSON.parse(binding.inputs.last['messages'].last['content']))
    assert_empty ChildAgent.rpc_methods
    refute ChildAgent.respond_to?(:agent_model)
  end
  def test_openai_json_arguments_and_call_id_roundtrip
    request = { 'id' => 'call-1', 'function' => { 'name' => 'remember', 'arguments' => '{"value":"日本語🌿"}' } }
    binding = Binding.new({ 'choices' => [{ 'message' => { 'tool_calls' => [request] } }] }, { 'response' => 'OK' })
    agent.run!(binding, 'test', input: 'hello')
    assert_equal '日本語🌿', agent.memory['value']
    assert_equal 'call-1', binding.inputs.last['messages'].last['tool_call_id']
  end
  def test_invalid_batch_executes_no_tools
    [call('send'), call('remember', {}), call('remember', { 'value' => 1 }), call('remember', { 'value' => 'x', 'extra' => true })].each do |invalid|
      binding = Binding.new({ 'tool_calls' => [call, invalid] })
      assert_raises(Pondro::Agent::Error) { agent.run!(binding, 'test', input: 'hello') }
      assert_empty agent.memory
    end
  end
  def test_step_limit_does_not_start_an_unfinishable_tool
    binding = Binding.new({ 'tool_calls' => [call] })
    assert_raises(Pondro::Agent::Error) { agent.run!(binding, 'test', input: 'hello', max_steps: 1) }
    assert_empty agent.memory
    assert_raises(ArgumentError) { agent.run!(binding, 'test', input: 'hello', max_steps: 0) }
  end
  def test_custom_helper_can_consume_a_non_sse_stream
    helper = Class.new do
      def self.complete(binding, model, input)
        value = JSON.parse(binding.readline)
        yield value['content']
        value
      end
    end
    binding = Struct.new(:readline).new('{"content":"NDJSON reply","tool_calls":[]}')
    deltas = []
    result = agent.run!(binding, 'test', input: 'hello', helper: helper) { |delta| deltas << delta }
    assert_equal 'NDJSON reply', result['text']
    assert_equal ['NDJSON reply'], deltas
  end
  def test_sse_assembles_tool_fragments_before_execution_and_closes_each_stream
    frames = [
      { 'choices' => [{ 'delta' => { 'tool_calls' => [{ 'index' => 0, 'id' => 'c1', 'function' => { 'name' => 'remember', 'arguments' => '{"value":' } }] } }] },
      { 'choices' => [{ 'delta' => { 'tool_calls' => [{ 'index' => 0, 'function' => { 'arguments' => '"green"}' } }] } }] }
    ].map { |frame| "data: #{JSON.generate(frame)}\r\n\r\n" }.join + "data: [DONE]\n\n"
    streams = [Stream.new(frames), Stream.new("data: {\"response\":\"Saved\"}\n\ndata: [DONE]\n\n")]
    remaining = streams.dup
    binding = Object.new
    binding.define_singleton_method(:stream!) { |*args| remaining.shift }
    result = agent.run!(binding, 'test', input: 'hello', helper: Pondro::Agent::SSE)
    assert_equal 'Saved', result['text']
    assert_equal 'green', agent.memory['value']
    assert streams.all?(&:closed)
  end
  def test_malformed_sse_arguments_close_stream_without_side_effects
    stream = Stream.new("data: {\"tool_calls\":[{\"name\":\"remember\",\"arguments\":\"{\"}]}\n\n")
    binding = Object.new
    binding.define_singleton_method(:stream!) { |*args| stream }
    assert_raises(JSON::ParserError) { agent.run!(binding, 'test', input: 'hello', helper: Pondro::Agent::SSE) }
    assert stream.closed
    assert_empty agent.memory
  end
  def test_unsupported_schema_is_rejected_at_declaration
    assert_raises(ArgumentError) do
      ChildAgent.tool(:bad, description: 'Bad', parameters: { 'type' => 'object', 'oneOf' => [] })
    end
  end
end
