module Pondro
  class Socket
    attr_reader :id, :params

    def initialize(id, effects, params = {})
      @id = id
      @effects = effects
      @params = params
    end

    def send(message)
      raise ArgumentError, 'Expected a text message' unless message.is_a?(String)
      @effects << { 'type' => 'socket.send', 'id' => id, 'message' => message }
      nil
    end

    # Opt-in immediate delivery, before the local snapshot commit.
    def send_now(message)
      raise ArgumentError, 'Expected a text message' unless message.is_a?(String)
      Future.new({ 'kind' => 'socket', 'operation' => 'send', 'id' => id, 'message' => message })
    end

    def close(code = 1000, reason = '')
      unless code == 1000 || (code >= 3000 && code <= 4999)
        raise ArgumentError, 'Invalid close code'
      end
      raise ArgumentError, 'Close reason is too long' if reason.bytesize > 123
      @effects << { 'type' => 'socket.close', 'id' => id, 'code' => code, 'reason' => reason }
      nil
    end
  end

  module WebSocket
    def self.adapter_name
      'websocket'
    end

    def self.handles?(type)
      ['websocket.connect', 'websocket.message', 'websocket.close', 'websocket.error'].include?(type)
    end

    def self.dispatch(object, type, payload)
      socket = Socket.new(payload['id'], object.effects, payload['params'] || {})
      case type
      when 'websocket.connect'
        object.on_connect(socket)
      when 'websocket.message'
        object.on_message(socket, payload['message'])
      when 'websocket.close'
        object.on_close(socket, payload['code'], payload['reason'])
      when 'websocket.error'
        object.on_error(socket)
      end
      nil
    end

    def sockets
      (@context['sockets'] || []).map { |id| Socket.new(id, effects) }
    end

    def on_connect(socket); end
    def on_close(socket, code, reason); end
    def on_error(socket); end
  end
end
