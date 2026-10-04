module Pondro
  module Agent
    class Error < StandardError; end

    def self.adapter_name
      'agent'
    end

    def self.handles?(type)
      false
    end

    def self.included(base)
      base.extend(ClassMethods)
    end

    module ClassMethods
      def tool(name, description:, parameters:)
        Schema.check(parameters)
        raise ArgumentError, 'Tool parameters must be an object' unless parameters['type'] == 'object'
        @tools ||= {}
        @tools[name.to_s] = { 'name' => name.to_s, 'description' => description, 'parameters' => parameters }
      end

      def tools
        inherited = superclass.respond_to?(:tools) ? superclass.tools : {}
        inherited.merge(@tools || {})
      end
    end

    # A deliberately small schema vocabulary, shared by declaration and execution.
    module Schema
      TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']
      def self.check(schema)
        unless schema.is_a?(Hash) && TYPES.include?(schema['type']) &&
               (schema.keys - ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum']).empty?
          raise ArgumentError, 'Unsupported tool parameter schema'
        end
        if schema['type'] == 'object'
          properties = schema['properties'] || {}
          required = schema['required'] || []
          unless properties.is_a?(Hash) && required.is_a?(Array) && (required - properties.keys).empty? &&
                 [nil, true, false].include?(schema['additionalProperties'])
            raise ArgumentError, 'Invalid object parameter schema'
          end
          properties.each_value { |child| check(child) }
        elsif schema['type'] == 'array'
          check(schema['items'])
        end
        raise ArgumentError, 'Invalid enum' if schema.key?('enum') && !schema['enum'].is_a?(Array)
      end

      def self.validate(value, schema)
        valid = case schema['type']
        when 'object' then value.is_a?(Hash)
        when 'array' then value.is_a?(Array)
        when 'string' then value.is_a?(String)
        when 'integer' then value.is_a?(Integer)
        when 'number' then value.is_a?(Numeric)
        when 'boolean' then value == true || value == false
        when 'null' then value.nil?
        end
        raise Error, 'Invalid tool arguments: expected ' + schema['type'] unless valid
        raise Error, 'Invalid tool arguments: enum' if schema.key?('enum') && !schema['enum'].include?(value)
        if value.is_a?(Hash)
          properties = schema['properties'] || {}
          raise Error, 'Missing required tool argument' unless ((schema['required'] || []) - value.keys).empty?
          if schema['additionalProperties'] == false && !(value.keys - properties.keys).empty?
            raise Error, 'Unknown tool argument'
          end
          properties.each { |key, child| validate(value[key], child) if value.key?(key) }
        elsif value.is_a?(Array)
          value.each { |item| validate(item, schema['items']) }
        end
      end
    end

    # Input may be text or a messages array. The returned transcript is owned by
    # the caller; persistence and memory policy remain ordinary application state.
    def run!(binding, model, input:, max_steps: 8, helper: WorkersAI, options: {}, &delta)
      raise ArgumentError, 'max_steps must be a positive integer' unless max_steps.is_a?(Integer) && max_steps > 0
      messages = input.is_a?(String) ? [{ 'role' => 'user', 'content' => input }] : input
      raise ArgumentError, 'input must be text or a messages array' unless messages.is_a?(Array)
      messages = JSON.parse(JSON.generate(messages))
      definitions = self.class.tools
      max_steps.times do |step|
        request = options.merge({ 'messages' => messages, 'tools' => definitions.values })
        raise Error, 'Agent input exceeded 256 KiB' if JSON.generate(request).bytesize > 262_144
        response = helper.complete(binding, model, request, &delta)
        calls = response['tool_calls'] || []
        text = response['content'] || ''
        raise Error, 'Invalid agent response' unless text.is_a?(String) && calls.is_a?(Array)
        if calls.empty?
          raise Error, 'AI returned an empty reply' if text.empty?
          messages << { 'role' => 'assistant', 'content' => text }
          return { 'text' => text, 'messages' => messages, 'steps' => step + 1 }
        end
        # The last allowed model call cannot start tools whose results cannot be read.
        raise Error, 'Agent exceeded max_steps' if step + 1 == max_steps
        raise Error, 'Too many tool calls in one step' if calls.length > 16
        prepared = calls.map do |call|
          raise Error, 'Invalid tool call' unless call.is_a?(Hash)
          definition = definitions[call['name']]
          raise Error, 'Unknown tool: ' + call['name'].to_s unless definition
          arguments = call['arguments']
          arguments = JSON.parse(arguments) if arguments.is_a?(String)
          Schema.validate(arguments, definition['parameters'])
          [call, arguments]
        end
        results = prepared.map do |call, arguments|
          value = send(call['name'], arguments)
          content = JSON.generate(value)
          raise Error, 'Tool result exceeded 64 KiB' if content.bytesize > 65_536
          { 'call' => call, 'content' => content }
        end
        helper.append(messages, response, results)
      end
    end
  end
end
