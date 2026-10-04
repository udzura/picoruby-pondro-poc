module Pondro
  module Agent
    # Helpers own request/response protocols. run! only sees content and complete
    # tool calls, so a custom helper may consume SSE, NDJSON, or another stream.
    class WorkersAI
      def self.complete(binding, model, input)
        response = normalize(binding.run(model, input.merge({ 'stream' => false })))
        yield response['content'] if block_given? && !response['content'].empty?
        response
      end

      def self.normalize(value)
        raise Error, 'Invalid AI response' unless value.is_a?(Hash)
        raise Error, 'AI provider error: ' + JSON.generate(value['error']) if value['error']
        choice = value['choices'].is_a?(Array) ? value['choices'].first : nil
        message = choice.is_a?(Hash) ? choice['message'] : nil
        message = value unless message.is_a?(Hash)
        content = message['content'] || message['response'] || ''
        calls = message['tool_calls'] || []
        raise Error, 'Invalid AI response' unless content.is_a?(String) && calls.is_a?(Array)
        raise Error, 'AI response exceeded 64 KiB' if JSON.generate(message).bytesize > 65_536
        normalized = calls.map do |call|
          raise Error, 'Invalid tool call' unless call.is_a?(Hash)
          function = call['function'] || call
          raise Error, 'Invalid tool function' unless function.is_a?(Hash)
          { 'id' => call['id'], 'name' => function['name'], 'arguments' => function['arguments'] }
        end
        reasoning_bytes = ['reasoning', 'reasoning_content'].inject(0) do |bytes, key|
          bytes + (message[key].is_a?(String) ? message[key].bytesize : 0)
        end
        { 'content' => content, 'tool_calls' => normalized, 'diagnostics' => {
          'response_keys' => value.keys, 'message_keys' => message.keys,
          'finish_reason' => choice.is_a?(Hash) ? choice['finish_reason'] : value['finish_reason'],
          'reasoning_bytes' => reasoning_bytes, 'usage' => value['usage'],
          'status' => value['status'], 'incomplete_details' => value['incomplete_details']
        } }
      end

      def self.append(messages, response, results)
        calls = response['tool_calls'].map do |call|
          if call['id']
            { 'id' => call['id'], 'type' => 'function', 'function' => {
              'name' => call['name'], 'arguments' => call['arguments'].is_a?(String) ? call['arguments'] : JSON.generate(call['arguments']) } }
          else
            { 'name' => call['name'], 'arguments' => call['arguments'] }
          end
        end
        messages << { 'role' => 'assistant', 'content' => response['content'], 'tool_calls' => calls }
        results.each do |result|
          call = result['call']
          message = { 'role' => 'tool', 'name' => call['name'], 'content' => result['content'] }
          message['tool_call_id'] = call['id'] if call['id']
          messages << message
        end
      end
    end

    # Text and tool arguments can be split across frames. Tools are only exposed
    # to run! after the stream has ended and their arguments are complete.
    class SSE < WorkersAI
      def self.complete(binding, model, input)
        stream = binding.stream!(:run, model, input)
        content = ''
        calls = {}
        native_calls = []
        data = []
        bytes = 0
        consume = lambda do
          frame = normalize_frame(data.join("\n"))
          if frame
            text = frame['response']
            choice = frame['choices'].is_a?(Array) ? frame['choices'].first : nil
            delta = choice.is_a?(Hash) ? choice['delta'] : nil
            text = delta['content'] if delta.is_a?(Hash) && delta['content'].is_a?(String)
            if text.is_a?(String)
              content += text
              yield text if block_given? && !text.empty?
            end
            native_calls.concat(frame['tool_calls']) if frame['tool_calls'].is_a?(Array)
            if delta.is_a?(Hash) && delta['tool_calls']
              raise Error, 'Invalid streamed tool calls' unless delta['tool_calls'].is_a?(Array)
              delta['tool_calls'].each do |part|
                unless part.is_a?(Hash) && part['index'].is_a?(Integer) && part['index'] >= 0 && part['index'] < 16
                  raise Error, 'Invalid streamed tool index'
                end
                call = calls[part['index']] ||= { 'id' => '', 'function' => { 'name' => '', 'arguments' => '' } }
                call['id'] += part['id'] if part['id'].is_a?(String)
                function = part['function'] || {}
                raise Error, 'Invalid streamed tool function' unless function.is_a?(Hash)
                ['name', 'arguments'].each do |key|
                  call['function'][key] += function[key] if function[key].is_a?(String)
                end
              end
            end
          end
          data = []
        end
        done = false
        while (line = stream.readline(max_bytes: 65_536))
          bytes += line.bytesize
          raise Error, 'AI stream exceeded 256 KiB' if bytes > 262_144
          line = line.chomp
          if line.empty?
            unless data.empty?
              if data.join("\n") == '[DONE]'
                done = true
                break
              end
              consume.call
            end
          elsif line.start_with?('data:')
            data << line[5..-1].lstrip
          end
        end
        consume.call unless done || data.empty? || data.join("\n") == '[DONE]'
        normalize({ 'response' => content, 'tool_calls' => native_calls + calls.keys.sort.map { |index| calls[index] } })
      ensure
        stream.close if stream
      end

      def self.normalize_frame(data)
        frame = JSON.parse(data)
        raise Error, 'Invalid AI stream frame' unless frame.is_a?(Hash)
        raise Error, 'AI provider error: ' + JSON.generate(frame['error']) if frame['error']
        frame
      end
    end
  end
end
