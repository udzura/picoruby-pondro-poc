module Pondro
  module Example2
    # Workers AI uses SSE. A StreamFuture delivers complete binary lines,
    # including when a UTF-8 character was split across host chunks.
    module SSE
      def self.each_delta(stream)
        data = []
        bytes = 0
        while (line = stream.readline(max_bytes: 65_536))
          bytes += line.bytesize
          raise BindingError, 'AI stream exceeded 256 KiB' if bytes > 262_144
          line = line.chomp
          if line.empty?
            unless data.empty?
              value = data.join("\n")
              return if value == '[DONE]'
              delta = decode(value)
              yield delta if delta && !delta.empty?
              data = []
            end
          elsif line.start_with?('data:')
            data << line[5..-1].lstrip
          end
        end
        unless data.empty? || data.join("\n") == '[DONE]'
          delta = decode(data.join("\n"))
          yield delta if delta && !delta.empty?
        end
      end

      def self.decode(data)
        frame = JSON.parse(data)
        raise BindingError, 'Invalid AI stream event' unless frame.is_a?(Hash)
        raise BindingError, 'AI returned a stream error' if frame['error']
        return frame['response'] if frame['response'].is_a?(String)
        choices = frame['choices']
        if choices.is_a?(Array) && choices.first.is_a?(Hash)
          delta = choices.first['delta']
          return delta['content'] if delta.is_a?(Hash) && delta['content'].is_a?(String)
        end
        nil
      end
    end
  end
end
