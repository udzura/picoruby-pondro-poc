class Counter < Pondro::Object
  state :count, default: 0
  rpc :increment, :value, http: true

  def increment
    self.count += 1
  end

  def value
    count
  end
end

class ChatRoom < Pondro::Object
  use Pondro::WebSocket
  state :messages, default: []
  state :sequence, default: 0
  state :counter_id, default: nil
  rpc :history

  def history
    messages
  end

  def on_connect(socket)
    requested = socket.params['counter_id'] || id
    if requested.empty? || requested.length > 128
      socket.close(4000, 'Counter ID must be 1 to 128 characters')
      return
    end
    if counter_id && counter_id != requested
      socket.close(4000, 'Room already uses another Counter ID')
      return
    end
    self.counter_id = requested
    count = Counter[counter_id].value.await
    socket.send(JSON.generate({ 'type' => 'welcome', 'room' => id, 'history' => messages,
                               'counter_id' => counter_id, 'count' => count }))
  end

  def on_close(socket, code, reason)
    return if socket.params['counter_id'] && socket.params['counter_id'] != counter_id
    event = JSON.generate({ 'type' => 'left', 'id' => socket.id })
    sockets.each do |client|
      client.send(event) unless client.id == socket.id
    end
  end

  def on_message(socket, message)
    raise ArgumentError, 'Message must be 1 to 4096 bytes' if message.empty? || message.bytesize > 4096
    pending = Counter[counter_id || id].increment
    count = pending.await
    self.sequence += 1
    entry = { 'sequence' => sequence, 'sender' => socket.id, 'text' => message, 'count' => count }
    messages << entry
    messages.shift if messages.length > 50
    event = JSON.generate({ 'type' => 'message', 'entry' => entry,
                            'counter_id' => counter_id || id, 'count' => count })
    sockets.each { |client| client.send(event) }
  end
end

Pondro.register('Counter', Counter)
Pondro.register('ChatRoom', ChatRoom)
