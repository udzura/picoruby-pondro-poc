module Pondro
  module Example2
    # Workers AI uses SSE. A StreamFuture delivers complete binary lines,
    # including when a UTF-8 character was split across host chunks.
    module SSE
      def self.each_delta(stream, diagnostics = { 'frames' => 0, 'bytes' => 0, 'reasoning_bytes' => 0 })
        data = []
        bytes = 0
        while (line = stream.readline(max_bytes: 65_536))
          bytes += line.bytesize
          diagnostics['bytes'] = bytes
          raise BindingError, 'AI stream exceeded 256 KiB' if bytes > 262_144
          line = line.chomp
          if line.empty?
            unless data.empty?
              value = data.join("\n")
              if value == '[DONE]'
                diagnostics['done'] = true
                return
              end
              delta = decode(value, diagnostics)
              yield delta if delta && !delta.empty?
              data = []
            end
          elsif line.start_with?('data:')
            data << line[5..-1].lstrip
          end
        end
        unless data.empty? || data.join("\n") == '[DONE]'
          delta = decode(data.join("\n"), diagnostics)
          yield delta if delta && !delta.empty?
        end
      end

      def self.decode(data, diagnostics)
        frame = JSON.parse(data)
        raise BindingError, 'Invalid AI stream event' unless frame.is_a?(Hash)
        diagnostics['frames'] += 1
        diagnostics['last_frame_keys'] = frame.keys
        diagnostics['usage'] = frame['usage'] if frame['usage'].is_a?(Hash)
        if frame['error']
          error = frame['error']
          detail = error.is_a?(Hash) ? JSON.generate(error) : error.to_s
          raise BindingError, 'AI returned a stream error: ' + detail[0, 1024]
        end
        return frame['response'] if frame['response'].is_a?(String)
        choices = frame['choices']
        if choices.is_a?(Array) && choices.first.is_a?(Hash)
          diagnostics['finish_reason'] = choices.first['finish_reason'] if choices.first['finish_reason'].is_a?(String)
          delta = choices.first['delta']
          if delta.is_a?(Hash)
            diagnostics['last_delta_keys'] = delta.keys
            ['reasoning', 'reasoning_content'].each do |key|
              diagnostics['reasoning_bytes'] += delta[key].bytesize if delta[key].is_a?(String)
            end
          end
          return delta['content'] if delta.is_a?(Hash) && delta['content'].is_a?(String)
        end
        nil
      end
    end
  end
end
