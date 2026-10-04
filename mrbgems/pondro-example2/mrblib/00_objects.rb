module Example2
  module Registration
    def do_initialize
      super
      register_object
    end

    def do_resume
      super
      register_object
    end

    private

    def register_object
      registry_id = @context['object_registry']
      return unless registry_id
      ObjectRegistry[registry_id].register({ 'class' => Pondro.registered_name(self.class), 'id' => id }).await
    end
  end

  class Object < Pondro::Object
    include Registration
  end
end

# The manager deliberately uses the plain base, so it never registers itself.
class ObjectRegistry < Pondro::Object
  state :objects, default: {}
  rpc :register, :list, :clear

  def register(identity)
    raise ArgumentError, 'Cannot track ObjectRegistry itself' if identity['class'] == 'ObjectRegistry'
    key = JSON.generate([identity['class'], identity['id']])
    objects[key] = identity
    nil
  end

  def list
    objects.values
  end

  def clear
    count = objects.length
    objects.each_value do |identity|
      Pondro::Future.new({ 'kind' => 'object.reset', 'class' => identity['class'], 'id' => identity['id'] }).await
    end
    self.objects = {}
    { 'cleared' => count }
  end
end

Pondro.register('ObjectRegistry', ObjectRegistry)

# Include the original playground objects when running the Example 2 profile.
[Counter, ChatRoom, BindingProbe, StreamProbe, GenericProbe].each do |klass|
  klass.include(Example2::Registration)
end
