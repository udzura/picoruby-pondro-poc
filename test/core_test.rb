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

class LifecycleObject < Pondro::Object
  state :boots, default: []
  rpc :inspect_session, :fail

  def do_initialize
    boots << 'initialize'
    @session = 'new'
    ::Object.new # A hook's return value is ignored, even when it is not JSON.
  end

  def do_resume
    boots << 'resume'
    @session = 'restored'
  end

  def inspect_session
    @visits = (@visits || 0) + 1
    { 'session' => @session, 'visits' => @visits, 'context' => @context['label'] }
  end

  def fail
    boots << 'discarded'
    @effects << { 'type' => 'discarded' }
    raise 'event failed'
  end
end
Pondro.register('LifecycleObject', LifecycleObject)

class CoreTest < Minitest::Test
  def test_lifecycle_keeps_instance_variables_but_restores_state_context_and_effects
    saved = {}
    run = lambda do |type, method = nil, label = nil|
      result = JSON.parse(Pondro.dispatch(JSON.generate({ 'class' => 'LifecycleObject', 'id' => 'lifecycle-test',
        'managed' => true, 'type' => type, 'state' => saved, 'context' => { 'label' => label },
        'payload' => { 'method' => method } })))
      saved = result['state'] if result['ok']
      result
    end
    assert run.call('lifecycle.initialize')['ok']
    first = run.call('rpc', 'inspect_session', 'first')
    assert_equal({ 'session' => 'new', 'visits' => 1, 'context' => 'first' }, first['value'])
    refute run.call('rpc', 'fail')['ok']
    second = run.call('rpc', 'inspect_session', 'second')
    assert_equal({ 'session' => 'new', 'visits' => 2, 'context' => 'second' }, second['value'])
    assert_equal ['initialize'], saved['boots']
    assert_empty second['effects']
    assert run.call('lifecycle.resume')['ok']
    resumed = run.call('rpc', 'inspect_session')
    assert_equal 'restored', resumed['value']['session']
    assert_equal 1, resumed['value']['visits']
    assert_equal ['initialize', 'resume'], saved['boots']
    refute run.call('rpc', 'do_initialize')['ok']
  end
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
