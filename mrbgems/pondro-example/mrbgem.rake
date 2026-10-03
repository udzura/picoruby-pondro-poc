MRuby::Gem::Specification.new('pondro-example') do |spec|
  spec.license = 'MIT'
  spec.author = 'udzura'
  spec.summary = 'Counter and chat room PONDRO examples'
  spec.add_dependency 'pondro-core'
  spec.add_dependency 'pondro-websocket'
  spec.add_dependency 'pondro-rpc'
end
