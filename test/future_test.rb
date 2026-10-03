require 'json'
require 'minitest/autorun'
load File.expand_path('../mrbgems/pondro-core/mrblib/pondro.rb', __dir__)
load File.expand_path('../mrbgems/pondro-rpc/mrblib/rpc.rb', __dir__)

module Pondro
  class << self
    attr_accessor :requests, :reads, :response
    def __rpc_start(json)
      requests << JSON.parse(json)
      requests.length
    end
    def __rpc_await(token)
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
end
