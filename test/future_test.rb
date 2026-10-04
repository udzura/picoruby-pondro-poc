require 'json'
require 'minitest/autorun'
load File.expand_path('../mrbgems/pondro-core/mrblib/pondro.rb', __dir__)
load File.expand_path('../mrbgems/pondro-async/mrblib/future.rb', __dir__)
load File.expand_path('../mrbgems/pondro-rpc/mrblib/rpc.rb', __dir__)
load File.expand_path('../mrbgems/pondro-bindings/mrblib/bindings.rb', __dir__)
load File.expand_path('../mrbgems/pondro-bindings/mrblib/streams.rb', __dir__)

module Pondro
  class << self
    attr_accessor :requests, :reads, :response
    def __async_start(json)
      requests << JSON.parse(json)
      requests.length
    end
    def __async_await(token)
      reads << token
      JSON.generate(response)
    end
  end
end

class TestCounter < Pondro::Object
  rpc :increment
end
Pondro.register('Counter', TestCounter)

class FutureTest < Minitest::Test
  def setup
    Pondro.requests = []
    Pondro.reads = []
    Pondro.response = { 'ok' => true, 'value' => 7 }
  end

  def test_eager_start_and_cached_await_with_read_alias
    pending = TestCounter['room'].increment
    assert_instance_of Pondro::Future, pending
    assert_equal [{ 'class' => 'Counter', 'id' => 'room', 'method' => 'increment', 'args' => [] }], Pondro.requests
    assert_empty Pondro.reads
    assert_equal 7, pending.await
    assert_equal 7, pending.await
    assert_equal 7, pending.read
    assert_equal [1], Pondro.reads
  end

  def test_remote_exception_is_rescuable_and_cached
    Pondro.response = { 'ok' => false, 'error' => 'counter failed' }
    pending = TestCounter['room'].increment
    first = assert_raises(Pondro::RemoteError) { pending.await }
    second = assert_raises(Pondro::RemoteError) { pending.await }
    assert_same first, second
    assert_equal 'counter failed', first.message
    assert_equal [1], Pondro.reads
  end

  def test_method_allowlist_and_object_id
    assert_raises(Pondro::DispatchError) { TestCounter['room'].unknown }
    assert_raises(ArgumentError) { TestCounter[''] }
    assert_empty Pondro.requests
  end
  def test_binding_failure_is_rescuable_and_cached
    env = Pondro::Bindings::Environment.new({ 'CACHE' => 'kv' })
    Pondro.response = { 'ok' => false, 'error' => 'binding failed' }
    pending = env[:CACHE].get('missing')
    first = assert_raises(Pondro::BindingError) { pending.await }
    second = assert_raises(Pondro::BindingError) { pending.read }
    assert_same first, second
    assert_equal [1], Pondro.reads
    assert_raises(Pondro::BindingError) { env[:UNKNOWN] }
  end

  def test_future_maps_once_and_caches_transform_errors
    Pondro.response = { 'ok' => true, 'value' => 7 }
    calls = 0
    pending = Pondro::Future.new({}) { |value| calls += 1; raise 'decode failed' }
    first = assert_raises(RuntimeError) { pending.await }
    assert_same first, assert_raises(RuntimeError) { pending.await }
    assert_equal 1, calls
  end

  def test_buffered_ai_does_not_mistake_json_for_a_stream_handle
    value = { 'stream_id' => 42, 'response' => 'hello' }
    Pondro.response = { 'ok' => true, 'value' => value }
    ai = Pondro::Bindings::Environment.new({ 'AI' => 'ai' })[:AI]
    assert_equal value, ai.generate('model', { 'prompt' => 'hello' }).await
  end

  def test_binding_dot_access_and_normal_missing_methods
    env = Pondro::Bindings::Environment.new({ 'AI' => 'ai', 'CACHE' => 'kv' })
    assert_instance_of Pondro::Bindings::AI, env.AI
    assert_instance_of Pondro::Bindings::KV, env.CACHE
    assert env.respond_to?(:AI)
    refute env.respond_to?(:UNKNOWN)
    assert_raises(NoMethodError) { env.UNKNOWN }
    assert_raises(NoMethodError) { env.AI('unexpected') }
    assert_raises(NoMethodError) { env.AI { 'unexpected' } }
  end

  def test_generic_binding_forwards_keywords_and_supports_explicit_invoke
    env = Pondro::Bindings::Environment.new({ 'SERVICE' => 'generic' })
    assert_equal 7, env.SERVICE.execute(1, enabled: true).await
    assert_equal({ 'kind' => 'binding', 'operation' => 'pondro.call', 'binding' => 'SERVICE',
      'args' => ['execute', '[1,{"enabled":true}]'] }, Pondro.requests.first)
    assert_equal 7, env.SERVICE.invoke(:class).await
    assert_equal 'class', Pondro.requests.last['args'].first
    assert_raises(ArgumentError) { env.SERVICE.execute { 'unsupported' } }
    Pondro.response = { 'ok' => false, 'error' => 'Binding is not configured: SERVICE' }
    assert_raises(Pondro::BindingError) { env.SERVICE.execute.await }
  end

end
