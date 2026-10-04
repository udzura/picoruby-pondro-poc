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

# A small binding integration sample; calls exercise the same Future as DO RPC.
class BindingProbe < Pondro::Object
  use Pondro::Bindings
  rpc :store_note, :read_note, http: true

  def store_note(text)
    raise ArgumentError, 'Note must be a string of at most 4096 bytes' unless text.is_a?(String) && text.bytesize <= 4096
    db = bindings[:DB]
    db.prepare('CREATE TABLE IF NOT EXISTS pondro_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)').run.await
    db.prepare('INSERT OR REPLACE INTO pondro_notes (id, body) VALUES (?, ?)').bind(id, text).run.await
    bindings[:CACHE].put(id, text).await
    read_note
  end

  def read_note
    cached = bindings[:CACHE].get(id)
    stored = bindings[:DB].prepare('SELECT body FROM pondro_notes WHERE id = ?').bind(id).first('body')
    { 'kv' => cached.await, 'd1' => stored.await }
  end
end
Pondro.register('BindingProbe', BindingProbe)

class StreamProbe < Pondro::Object
  use Pondro::Bindings
  use Pondro::WebSocket
  rpc :read_object, http: true
  rpc :read_ai, :abandon_read, :abandon_open

  def read_object(key, mode = 'read_all', limit = 1024 * 1024)
    object = bindings[:BUCKET].get(key).await
    return nil unless object
    stream = object.body
    return nil unless stream
    consume_stream(stream, mode, limit)
  end

  def abandon_read(key)
    bindings[:BUCKET].get(key).await.body.read_partial(1)
    'abandoned'
  end

  def abandon_open(key)
    bindings[:BUCKET].get(key)
    'abandoned'
  end

  def read_ai(model, input, mode = 'read_all', limit = 1024 * 1024)
    stream = bindings.AI.generate(model, input, stream: true).await
    consume_stream(stream, mode, limit)
  end

  def consume_stream(stream, mode, limit)
    value = case mode
    when 'read_partial' then stream.read_partial(limit).await
    when 'readline' then stream.readline(max_bytes: limit).await
    when 'read_all' then stream.read_all(max_bytes: limit).await
    else raise ArgumentError, 'Unknown read mode'
    end
    value.nil? ? nil : value.bytes
  end

  def on_connect(socket)
    socket.send(JSON.generate({ 'type' => 'ready' }))
  end

  def on_message(socket, key)
    stream = bindings[:BUCKET].get(key).await.body
    while (line = stream.readline.await)
      socket.send_now(JSON.generate({ 'type' => 'line', 'text' => line })).await
    end
    socket.send(JSON.generate({ 'type' => 'done' }))
  end
end
Pondro.register('StreamProbe', StreamProbe)

# Generic binding smoke sample; names must be exported by the JS registry.
class GenericProbe < Pondro::Object
  use Pondro::Bindings
  rpc :call_service
  rpc :execute_service

  def call_service(name, method, args = [], options = {})
    bindings[name].invoke(method, *args, **options).await
  end

  def execute_service(args = [], options = {})
    bindings.SERVICE.execute(*args, **options).await
  end
end
Pondro.register('GenericProbe', GenericProbe)
