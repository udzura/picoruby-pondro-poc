class AICatalog < Pondro::Object
  state :entries, default: {}
  rpc :list, http: true
  rpc :register

  def list
    entries.values
  end

  def register(ai_id, display_name)
    entries[ai_id] = { 'id' => ai_id, 'name' => display_name }
    nil
  end
end

class AIParticipant < Pondro::Object
  MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8'
  state :name, default: nil
  state :prompt, default: nil
  state :rooms, default: []
  rpc :configure, :profile, :load, http: true
  rpc :join, :leave

  # The first configuration wins. Reusing an AI ID loads its original persona.
  def configure(display_name, personality)
    return { 'created' => false, 'profile' => load } if prompt
    validate_text(display_name, 128, 'AI name')
    validate_text(personality, 4096, 'Personality prompt')
    self.name = display_name
    self.prompt = personality
    AICatalog['default'].register(id, name).await
    { 'created' => true, 'profile' => profile }
  end

  def profile
    return nil unless prompt
    { 'id' => id, 'name' => name, 'prompt' => prompt, 'model' => MODEL, 'rooms' => rooms }
  end

  # Loading also indexes personas created before the catalog was introduced.
  def load
    return nil unless prompt
    AICatalog['default'].register(id, name).await
    profile
  end

  def join(room_id)
    raise Pondro::DispatchError, 'Create this AI before inviting it' unless prompt
    validate_text(room_id, 128, 'Room ID')
    unless rooms.include?(room_id)
      raise Pondro::DispatchError, 'AI already belongs to 100 rooms' if rooms.length >= 100
      rooms << room_id
    end
    profile
  end

  def leave(room_id)
    validate_text(room_id, 128, 'Room ID')
    rooms.delete(room_id)
    profile
  end

  private

  def validate_text(value, limit, label)
    unless value.is_a?(String) && !value.strip.empty? && value.bytesize <= limit
      raise ArgumentError, label + ' must be nonempty and at most ' + limit.to_s + ' bytes'
    end
  end
end

class AIChatRoom < Pondro::Object
  use Pondro::WebSocket
  use Pondro::Bindings
  state :participants, default: []
  state :messages, default: []
  state :sequence, default: 0
  rpc :history

  def history
    messages
  end

  def on_connect(socket)
    name = human_name(socket) # Validate the immutable connection parameters.
    socket.send(JSON.generate({ 'type' => 'welcome', 'room' => id, 'self' => socket.id,
                               'history' => messages, 'participants' => participants,
                               'ai_mode' => @context['ai_mode'] || 'live' }))
    announce_join({ 'kind' => 'human', 'id' => socket.id, 'name' => name })
  end

  def on_close(socket, code, reason)
    sockets.each do |client|
      client.send(JSON.generate({ 'type' => 'notice', 'text' => human_name(socket) + ' left the room.' })) unless client.id == socket.id
    end
  end

  def on_message(socket, message)
    event = JSON.parse(message)
    raise ArgumentError, 'Expected a chat event' unless event.is_a?(Hash)
    case event['type']
    when 'invite' then invite(socket, event['ai_id'])
    when 'remove' then remove(event['ai_id'])
    when 'say' then say(socket, event['text'])
    else raise ArgumentError, 'Unknown chat event'
    end
  rescue StandardError => error
    socket.send(JSON.generate({ 'type' => 'error', 'text' => error.message }))
  end

  private

  def human_name(socket)
    value = socket.params['name'] || 'Guest'
    unless value.is_a?(String) && !value.strip.empty? && value.bytesize <= 128
      raise ArgumentError, 'Display name must be 1 to 128 bytes'
    end
    value
  end

  def invite(socket, ai_id)
    validate_ai_id(ai_id)
    if participants.any? { |participant| participant['id'] == ai_id }
      socket.send(JSON.generate({ 'type' => 'participants', 'participants' => participants }))
      return
    end
    raise ArgumentError, 'A room can have at most 4 AI participants' if participants.length >= 4
    profile = AIParticipant[ai_id].join(id).await
    participants << { 'id' => ai_id, 'name' => profile['name'] }
    sockets.each { |client| client.send(JSON.generate({ 'type' => 'participants', 'participants' => participants })) }
    announce_join({ 'kind' => 'ai', 'id' => ai_id, 'name' => profile['name'] })
  end

  def announce_join(participant)
    payload = JSON.generate({ 'type' => 'notice', 'action' => 'join', 'participant' => participant,
                              'text' => participant['name'] + ' joined the room.' })
    sockets.each { |client| client.send(payload) }
  end

  def remove(ai_id)
    validate_ai_id(ai_id)
    if participants.any? { |participant| participant['id'] == ai_id }
      AIParticipant[ai_id].leave(id).await
      self.participants = participants.reject { |participant| participant['id'] == ai_id }
    end
    sockets.each { |client| client.send(JSON.generate({ 'type' => 'participants', 'participants' => participants })) }
  end

  def validate_ai_id(ai_id)
    unless ai_id.is_a?(String) && !ai_id.empty? && ai_id.length <= 128
      raise ArgumentError, 'AI ID must be 1 to 128 characters'
    end
  end

  def say(socket, text)
    unless text.is_a?(String) && !text.strip.empty? && text.bytesize <= 2000
      raise ArgumentError, 'Message must be 1 to 2000 bytes'
    end
    entry = entry_for({ 'kind' => 'human', 'id' => socket.id, 'name' => human_name(socket) }, text)
    remember(entry)
    broadcast_now({ 'type' => 'message', 'entry' => entry })
    participants.each { |participant| reply(participant) }
    broadcast_now({ 'type' => 'ready' })
  end

  def reply(participant)
    entry = entry_for({ 'kind' => 'ai', 'id' => participant['id'], 'name' => participant['name'] }, '')
    stream = nil
    begin
      broadcast_now({ 'type' => 'ai_start', 'entry' => entry })
      profile = AIParticipant[participant['id']].profile.await
      input = { 'messages' => conversation(profile), 'max_tokens' => 512 }
      stream = bindings.AI.stream!(:generate, profile['model'], input)
      Pondro::Example2::SSE.each_delta(stream) do |delta|
        raise Pondro::BindingError, 'AI reply exceeded 16 KiB' if entry['text'].bytesize + delta.bytesize > 16_384
        entry['text'] += delta
        broadcast_now({ 'type' => 'ai_delta', 'sequence' => entry['sequence'], 'delta' => delta })
      end
      raise Pondro::BindingError, 'AI returned an empty reply' if entry['text'].empty?
      remember(entry)
      broadcast_now({ 'type' => 'message', 'entry' => entry })
    rescue StandardError => error
      broadcast_now({ 'type' => 'ai_error', 'sequence' => entry['sequence'], 'text' => error.message })
    ensure
      begin
        stream.close if stream
      rescue Pondro::BindingError
        # Event cleanup also cancels failed or unread sources.
      end
    end
  end

  def conversation(profile)
    system = profile['prompt'] + "\nYour display name is " + profile['name'] + '. Reply to the latest message in this shared chat.'
    [{ 'role' => 'system', 'content' => system }] + messages.last(20).map do |entry|
      own_reply = entry['sender']['kind'] == 'ai' && entry['sender']['id'] == profile['id']
      { 'role' => own_reply ? 'assistant' : 'user',
        'content' => own_reply ? entry['text'] : entry['sender']['name'] + ': ' + entry['text'] }
    end
  end

  def entry_for(sender, text)
    self.sequence += 1
    { 'sequence' => sequence, 'sender' => sender, 'text' => text }
  end

  def remember(entry)
    messages << entry
    messages.shift if messages.length > 50
  end

  def broadcast_now(event)
    payload = JSON.generate(event)
    sockets.each do |client|
      begin
        client.send_now(payload).await
      rescue Pondro::RemoteError
        # One departed client must not interrupt the other participants.
      end
    end
  end
end

Pondro.register('AICatalog', AICatalog)
Pondro.register('AIParticipant', AIParticipant)
Pondro.register('AIChatRoom', AIChatRoom)
