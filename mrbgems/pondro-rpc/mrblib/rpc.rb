module Pondro
  class RemoteError < StandardError; end

  class Future
    def initialize(request)
      @token = Pondro.__rpc_start(JSON.generate(request))
      @settled = false
    end

    def await
      unless @settled
        result = JSON.parse(Pondro.__rpc_await(@token))
        @value = result['value']
        @error = result['ok'] ? nil : RemoteError.new(result['error'])
        @settled = true
      end
      raise @error if @error
      @value
    end

    alias read await
  end

  class Reference
    def initialize(name, klass, id)
      @name = name
      @klass = klass
      @id = id
    end

    def method_missing(method, *args)
      method = method.to_s
      raise DispatchError, 'Method is not exported' unless @klass.rpc_methods.include?(method)
      Future.new({ 'class' => @name, 'id' => @id, 'method' => method, 'args' => args })
    end
  end

  class Object
    def self.[](id)
      raise ArgumentError, 'Object ID must be a nonempty string' unless id.is_a?(String) && !id.empty?
      Reference.new(Pondro.registered_name(self), self, id)
    end
  end
end
