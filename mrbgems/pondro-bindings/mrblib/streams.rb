module Pondro
  module Bindings
    class Stream < Binding
      MAX_BYTES = 1024 * 1024

      def initialize(id)
        raise BindingError, 'Invalid stream handle' unless id.is_a?(Integer) && id > 0
        super('')
        @id = id
      end

      def read_partial(length)
        read('read_partial', length)
      end

      def readline(max_bytes: MAX_BYTES)
        read('readline', max_bytes)
      end

      def read_all(max_bytes: MAX_BYTES)
        read('read_all', max_bytes)
      end

      def close
        call('stream.close', @id.to_s)
      end

      def read(operation, limit)
        minimum = operation == 'read_partial' ? 1 : 0
        unless limit.is_a?(Integer) && limit >= minimum && limit <= MAX_BYTES
          raise ArgumentError, 'Invalid stream byte limit (maximum 1 MiB)'
        end
        call('stream.' + operation, @id.to_s, limit.to_s) do |value|
          value.nil? ? nil : value['bytes'].pack('C*')
        end
      end
    end

    class R2 < Binding
      def get(key, options = {})
        call('r2.get', key, JSON.generate(options)) do |value|
          value.nil? ? nil : Result.new(value)
        end
      end

      class Result
        attr_reader :metadata, :body
        def initialize(value)
          @metadata = value['object']
          @body = value['stream_id'] ? Stream.new(value['stream_id']) : nil
        end
      end
    end

    class AI < Binding
      def run(model, input, options = {})
        streaming = input['stream'] == true || input[:stream] == true
        call('ai.run', model, JSON.generate(input), JSON.generate(options)) do |value|
          streaming ? Stream.new(value['stream_id']) : value
        end
      end

      def generate(model, input, stream: false, options: {})
        run(model, input.merge({ 'stream' => stream }), options)
      end
    end
  end
end
