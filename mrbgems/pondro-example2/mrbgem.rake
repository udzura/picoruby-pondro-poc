MRuby::Gem::Specification.new('pondro-example2') do |spec|
  spec.license = 'MIT'
  spec.author = 'udzura'
  spec.summary = 'Shared AI participants and WebSocket chat rooms'
  spec.add_dependency 'pondro-core'
  spec.add_dependency 'pondro-example'
  spec.add_dependency 'pondro-websocket'
  spec.add_dependency 'pondro-rpc'
  spec.add_dependency 'pondro-bindings'
  spec.add_dependency 'pondro-agent'
end
