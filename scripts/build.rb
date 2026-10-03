require 'fileutils'

root = File.expand_path('..', __dir__)
source = File.join(root, 'vendor/picoruby')
abort 'Run npm run setup first' unless File.directory?(source)
env = { 'MRUBY_CONFIG' => File.join(root, 'build_config/wasm.rb'),
        'MRUBY_BUILD_DIR' => File.join(root, 'build') }
abort 'PicoRuby build failed' unless system(env, 'ruby', 'minirake', chdir: source)
FileUtils.mkdir_p(File.join(root, 'dist'))
archive = File.join(root, 'build/pondro-wasm/lib/libmruby.a')
exports = %w[pondro_init pondro_dispatch pondro_destroy malloc free]
temporary = File.join(root, 'build/pondro.wasm')
args = ['emcc', archive, '--no-entry', '-O2', '-o', temporary,
        '-sSTANDALONE_WASM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=2097152',
        '-sSTACK_SIZE=262144', '-sMAXIMUM_MEMORY=33554432',
        '-sSUPPORT_LONGJMP=wasm', '-sWASM_LEGACY_EXCEPTIONS=0',
        "-sEXPORTED_FUNCTIONS=#{exports.map { |name| "_#{name}" }}"]
abort 'Wasm link failed' unless system(*args)
File.rename(temporary, File.join(root, 'dist/pondro.wasm'))
puts "Built dist/pondro.wasm (#{File.size(File.join(root, 'dist/pondro.wasm'))} bytes)"
