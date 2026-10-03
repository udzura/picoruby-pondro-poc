require 'fileutils'

root = File.expand_path('..', __dir__)
source = File.join(root, 'vendor/picoruby')
revision = '65b7ae6256faa2e53aa0cf8249c8ad5f1cd86327'
FileUtils.mkdir_p(File.dirname(source))
def run(*args)
  abort "Failed: #{args.join(' ')}" unless system(*args)
end
run('git', 'clone', 'https://github.com/picoruby/picoruby.git', source) unless File.directory?(source)
run('git', '-C', source, 'checkout', '--detach', revision)
run('git', '-C', source, 'submodule', 'update', '--init', '--recursive', '--depth', '1',
    'mrbgems/mruby-bin-mrbc', 'mrbgems/mruby-compiler', 'mrbgems/picoruby-mruby/lib/mruby')
