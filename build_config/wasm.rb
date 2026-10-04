root = File.expand_path('..', __dir__)
MRuby::CrossBuild.new('pondro-wasm') do |conf|
  conf.toolchain :clang
  conf.cc.command = 'emcc'
  conf.linker.command = 'emcc'
  conf.archiver.command = 'emar'
  conf.cc.flags.concat %w[-sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=0]
  conf.linker.flags.concat %w[-sSUPPORT_LONGJMP=wasm -sWASM_LEGACY_EXCEPTIONS=0]
  conf.ports :pondro
  conf.cc.defines.concat %w[PICORB_PLATFORM_WASM MRB_32BIT MRB_INT64 MRB_NO_BOXING MRB_UTF8_STRING]
  conf.picoruby(alloc_estalloc: false)
  gems = "#{MRUBY_ROOT}/mrbgems/picoruby-mruby/lib/mruby/mrbgems"
  %w[mruby-metaprog mruby-enum-ext mruby-string-ext mruby-array-ext mruby-hash-ext mruby-pack].each do |name|
    conf.gem gemdir: "#{gems}/#{name}"
  end
  conf.gem core: 'picoruby-json'
  %w[pondro-core pondro-async pondro-rpc pondro-bindings pondro-websocket pondro-example pondro-example2 pondro-wasm].each do |name|
    conf.gem gemdir: "#{root}/mrbgems/#{name}"
  end
end
