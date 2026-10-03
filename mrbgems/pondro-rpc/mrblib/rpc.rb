module Pondro
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
