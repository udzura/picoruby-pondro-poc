module Pondro
  class BindingError < RemoteError; end

  module Bindings
    def self.adapter_name
      'bindings'
    end

    def self.handles?(type)
      false
    end

    def bindings
      @bindings ||= Environment.new(@context['binding_types'] || {})
    end

    class Environment
      def initialize(types)
        @types = types
      end

      def method_missing(name, *args, &block)
        return self[name] if args.empty? && !block && @types.key?(name.to_s)
        super
      end

      def respond_to_missing?(name, include_private = false)
        @types.key?(name.to_s)
      end

      def [](name)
        name = name.to_s
        case @types[name]
        when 'kv' then KV.new(name)
        when 'd1' then D1.new(name)
        when 'r2' then R2.new(name)
        when 'ai' then AI.new(name)
        when 'generic' then Generic.new(name)
        else raise BindingError, 'Unknown or unsupported binding: ' + name
        end
      end
    end

    class Binding
      def initialize(name)
        @name = name
      end

      def call(operation, *args, &transform)
        Future.new({ 'kind' => 'binding', 'operation' => operation,
                     'binding' => @name, 'args' => args }, BindingError, &transform)
      end
    end

    class Generic
      def initialize(name)
        @name = name
      end

      def method_missing(name, *args, **options, &block)
        invoke(name, *args, **options, &block)
      end

      def respond_to_missing?(name, include_private = false)
        true
      end

      # Escape hatch for remote methods that collide with Ruby's own methods.
      def invoke(name, *args, **options, &block)
        raise ArgumentError, 'Binding calls do not accept blocks' if block
        args << options unless options.empty?
        Future.new({ 'kind' => 'binding', 'operation' => 'pondro.call',
                     'binding' => @name, 'args' => [name.to_s, JSON.generate(args)] }, BindingError)
      end
    end

    class KV < Binding
      def get(key)
        call('kv.get', key)
      end

      def put(key, value, ttl: nil)
        options = {}
        options['ttl'] = ttl unless ttl.nil?
        call('kv.put', key, value, JSON.generate(options))
      end
    end

    class D1 < Binding
      def prepare(sql)
        Statement.new(self, sql, [])
      end

      class Statement
        def initialize(database, sql, params)
          @database = database
          @sql = sql
          @params = params
        end

        def bind(*params)
          Statement.new(@database, @sql, params)
        end

        def run
          execute('run', {})
        end

        def first(column = nil)
          execute('first', { 'column' => column })
        end

        def raw(column_names: false)
          execute('raw', { 'columnNames' => column_names })
        end

        def execute(operation, options)
          request = { 'operation' => operation, 'sql' => @sql, 'params' => @params }.merge(options)
          @database.call('d1.execute', JSON.generate(request))
        end
      end
    end
  end
end
