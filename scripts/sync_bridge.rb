require 'json'
require 'digest'
require 'open-uri'

root = File.expand_path('../worker/upstream', __dir__)
manifest = JSON.parse(File.read(File.join(root, 'source.json')))
manifest['files'].each do |name, entry|
  url = "https://raw.githubusercontent.com/udzura/picoruby-cloudflare-worker-wasm/#{manifest['revision']}/#{entry['source']}"
  bytes = URI.open(url, &:read)
  abort "Checksum mismatch: #{name}" unless Digest::SHA256.hexdigest(bytes) == entry['sha256']
  path = File.join(root, name)
  File.binwrite(path, bytes) unless File.exist?(path) && File.binread(path) == bytes
  puts "Verified #{name} at #{manifest['revision']}"
end
