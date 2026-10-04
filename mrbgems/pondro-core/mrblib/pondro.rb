module Pondro
  class DispatchError < StandardError; end
  class HttpAccessError < DispatchError; end

  class Object
    def self.state(name, default: nil)
      name = name.to_s
      @defaults ||= {}
      @defaults[name] = default
      define_method(name) { @state[name] }
      define_method(name + '=') { |value| @state[name] = value }
    end

    def self.defaults
      inherited = superclass.respond_to?(:defaults) ? superclass.defaults : {}
      inherited.merge(@defaults || {})
    end

    # Only explicitly exported methods may be reached through RPC.
    def self.rpc(*names, http: false)
      @rpc_methods ||= []
      @http_rpc_methods ||= {}
      names.each do |name|
        @rpc_methods << name.to_s
        @http_rpc_methods[name.to_s] = http
      end
    end

    def self.rpc_methods
      inherited = superclass.respond_to?(:rpc_methods) ? superclass.rpc_methods : []
      inherited + (@rpc_methods || [])
    end

    def self.http_rpc_methods
      inherited = superclass.respond_to?(:http_rpc_methods) ? superclass.http_rpc_methods : {}
      inherited.merge(@http_rpc_methods || {})
    end

    def self.use(adapter)
      @adapters ||= []
      @adapters << adapter
      include adapter
    end

    def self.adapters
      inherited = superclass.respond_to?(:adapters) ? superclass.adapters : []
      inherited + (@adapters || [])
    end

    attr_reader :id

    def initialize(id, state, context)
      @id = id
      __restore_event(state, context)
    end

    def __restore_event(state, context)
      @state = JSON.parse(JSON.generate(self.class.defaults)).merge(state)
      @context = context
      @effects = []
    end

    def do_initialize
    end

    def do_resume
    end

    def dispatch(type, payload)
      if type == 'lifecycle.initialize'
        do_initialize
        return nil
      end
      if type == 'lifecycle.resume'
        do_resume
        return nil
      end
      return self.class.adapters.map { |adapter| adapter.adapter_name } if type == 'capabilities'
      if type == 'rpc' || type == 'http.rpc'
        method = payload['method']
        if type == 'http.rpc' && self.class.http_rpc_methods[method] != true
          raise HttpAccessError, 'Method is not exported over HTTP'
        end
        unless self.class.rpc_methods.include?(method)
          raise DispatchError, 'Method is not exported'
        end
        args = payload['args'] || []
        raise DispatchError, 'args must be an array' unless args.is_a?(Array)
        return send(method, *args)
      end
      self.class.adapters.each do |adapter|
        return adapter.dispatch(self, type, payload) if adapter.handles?(type)
      end
      raise DispatchError, 'Unsupported event'
    end

    def snapshot
      @state
    end

    def effects
      @effects
    end
  end

  @classes = {}
  @objects = {}

  def self.register(name, klass)
    @classes[name] = klass
  end

  def self.registered_name(klass)
    @classes.each do |name, candidate|
      return name if candidate == klass
    end
    raise DispatchError, 'Unregistered Pondro class'
  end

  # Managed objects survive for one host activation. Restore durable state and
  # event context each time, while keeping ordinary instance variables alive.
  def self.dispatch(json)
    input = JSON.parse(json)
    klass = @classes[input['class']]
    raise DispatchError, 'Unknown Pondro class' unless klass
    key = JSON.generate([input['class'], input['id']])
    lifecycle = input['type'] == 'lifecycle.initialize' || input['type'] == 'lifecycle.resume'
    object = input['managed'] && !lifecycle ? @objects[key] : nil
    if object
      object.__restore_event(input['state'] || {}, input['context'] || {})
    else
      object = klass.new(input['id'], input['state'] || {}, input['context'] || {})
    end
    value = object.dispatch(input['type'], input['payload'] || {})
    @objects[key] = object if input['managed']
    JSON.generate({ 'ok' => true, 'value' => value,
                    'state' => object.snapshot, 'effects' => object.effects })
  rescue HttpAccessError => error
    JSON.generate({ 'ok' => false, 'error' => error.message, 'code' => 'http_not_exported' })
  rescue StandardError => error
    JSON.generate({ 'ok' => false, 'error' => error.message })
  end
end
