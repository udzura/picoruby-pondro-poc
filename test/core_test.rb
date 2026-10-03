require 'json'
require 'minitest/autorun'
load File.expand_path('../mrbgems/pondro-core/mrblib/pondro.rb', __dir__)

class CoreOnly < Pondro::Object
  state :items, default: []
  rpc :append, :fail_after_mutation
  def append(value)
    items << value
  end
  def fail_after_mutation
    items << 'discarded'
    raise 'failed'
  end
end
class Child < CoreOnly
  rpc :append, http: true
end
class PrivateChild < Child
  rpc :append, http: false
end
Pondro.register('CoreOnly', CoreOnly)
Pondro.register('Child', Child)
Pondro.register('PrivateChild', PrivateChild)

class CoreTest < Minitest::Test
  def dispatch(klass = 'CoreOnly', method = 'append', args = ['a'], state = {}, type = 'rpc')
    JSON.parse(Pondro.dispatch(JSON.generate({ 'class' => klass, 'id' => 'test', 'type' => type,
      'state' => state, 'payload' => { 'method' => method, 'args' => args } })))
  end
  def test_core_does_not_load_websocket
    refute Pondro.const_defined?(:WebSocket)
    assert_equal ['a'], dispatch['value']
  end
  def test_inheritance_and_independent_defaults
    assert_equal ['a'], dispatch('Child')['value']
    assert_equal ['a'], dispatch['value']
  end
  def test_failure_discards_mutation_and_exports_are_explicit
    saved = { 'items' => ['saved'] }
    refute dispatch('CoreOnly', 'fail_after_mutation', [], saved)['ok']
    assert_equal ['saved'], saved['items']
    refute dispatch('CoreOnly', 'send', ['append', 'secret'])['ok']
    assert_equal ['a'], dispatch['value']
  end
  def test_http_is_opt_in_and_subclasses_can_restrict_it
    denied = dispatch('CoreOnly', 'append', ['a'], {}, 'http.rpc')
    assert_equal 'http_not_exported', denied['code']
    assert_equal ['a'], dispatch('Child', 'append', ['a'], {}, 'http.rpc')['value']
    refute dispatch('PrivateChild', 'append', ['a'], {}, 'http.rpc')['ok']
    assert_equal ['a'], dispatch('PrivateChild')['value']
    refute dispatch('Child', 'fail_after_mutation', [], {}, 'http.rpc')['ok']
  end

end
