module Pondro
  class StreamFuture < Future
    MAX_BYTES = 1024 * 1024

    # R2 has already opened its body; AI stream! starts an eager open request.
    def initialize(request = nil, id = nil)
      if request
        super(request, BindingError) { |value| validate_handle(value.is_a?(Hash) ? value['stream_id'] : nil) }
      else
        @value = validate_handle(id)
        @settled = true
      end
    end

    def await
      @id = super
      self
    end

    alias read await

    def read_partial(length)
      consume('read_partial', length)
    end

    def readline(max_bytes: MAX_BYTES)
      consume('readline', max_bytes)
    end

    def read_all(max_bytes: MAX_BYTES)
      consume('read_all', max_bytes)
    end

    def close
      await
      Future.new({ 'kind' => 'binding', 'operation' => 'stream.close',
                   'binding' => '', 'args' => [@id.to_s] }, BindingError).await
    end

    private

    def validate_handle(id)
      raise BindingError, 'Invalid stream handle' unless id.is_a?(Integer) && id > 0
      id
    end

    def consume(operation, limit)
      future_read(operation, limit).await
    end

    def future_read(operation, limit)
      minimum = operation == 'read_partial' ? 1 : 0
      unless limit.is_a?(Integer) && limit >= minimum && limit <= MAX_BYTES
        raise ArgumentError, 'Invalid stream byte limit (maximum 1 MiB)'
      end
      await
      Future.new({ 'kind' => 'binding', 'operation' => 'stream.' + operation,
                   'binding' => '', 'args' => [@id.to_s, limit.to_s] }, BindingError) do |value|
        value.nil? ? nil : value['bytes'].pack('C*')
      end
    end
  end

  module Bindings
    class R2 < Binding
      def get(key, options = {})
        future_get(key, options).await
      end

      class Result
        attr_reader :metadata, :body
        def initialize(value)
          @metadata = value['object']
          @body = value['stream_id'] ? StreamFuture.new(nil, value['stream_id']) : nil
        end
      end

      private

      def async_methods
        ['get']
      end

      def future_get(key, options = {})
        call('r2.get', key, JSON.generate(options)) do |value|
          value.nil? ? nil : Result.new(value)
        end
      end
    end

    class AI < Binding
      def run(model, input, options = {})
        future_run(model, input, options).await
      end

      def generate(model, input, stream: false, options: {})
        future_generate(model, input, stream: stream, options: options).await
      end

      def stream!(method, *args, **options, &block)
        raise ArgumentError, 'Binding calls do not accept blocks' if block
        name = method.to_s
        raise ArgumentError, 'Unsupported stream method: ' + name unless async_methods.include?(name)
        __send__('stream_' + name, *args, **options)
      end

      private

      def async_methods
        ['run', 'generate']
      end

      def future_run(model, input, options = {})
        streaming = input['stream'] == true || input[:stream] == true
        Future.new(request_run(model, input, options), BindingError) do |value|
          streaming ? StreamFuture.new(nil, value.is_a?(Hash) ? value['stream_id'] : nil) : value
        end
      end

      def future_generate(model, input, stream: false, options: {})
        future_run(model, streaming_input(input, stream), options)
      end

      def stream_run(model, input, options = {})
        StreamFuture.new(request_run(model, streaming_input(input), options))
      end

      def stream_generate(model, input, options: {})
        stream_run(model, input, options)
      end

      def streaming_input(input, stream = true)
        input.reject { |key, _| key.to_s == 'stream' }.merge({ 'stream' => stream })
      end

      def request_run(model, input, options)
        request('ai.run', model, JSON.generate(input), JSON.generate(options))
      end
    end
  end
end
