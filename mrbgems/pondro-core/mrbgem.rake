MRuby::Gem::Specification.new('pondro-core') do |spec|
  spec.license = 'MIT'
  spec.author = 'udzura'
  spec.summary = 'Durable Ruby object identity, state and event dispatch'
  spec.add_dependency 'picoruby-json'
  spec.add_dependency 'mruby-metaprog'
end
