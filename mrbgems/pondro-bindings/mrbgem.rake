MRuby::Gem::Specification.new('pondro-bindings') do |spec|
  spec.license = 'MIT'
  spec.author = 'udzura'
  spec.summary = 'Future-based resource and read-only stream proxies using the shared Worker host bridge'
  spec.add_dependency 'pondro-async'
  spec.add_dependency 'mruby-pack'
end
