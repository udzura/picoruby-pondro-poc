export class WebSocketAdapter {
  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }

  context() {
    return { sockets: this.ctx.getWebSockets().map(socket => socket.deserializeAttachment().id) };
  }

  handles(type) { return type === 'socket.send' || type === 'socket.close'; }

  apply(effect) {
    const socket = this.ctx.getWebSockets().find(s => s.deserializeAttachment().id === effect.id);
    if (!socket) return;
    if (effect.type === 'socket.send') socket.send(effect.message);
    else socket.close(effect.code, effect.reason);
  }

  async upgrade(request, identity) {
    const capabilities = await this.host.dispatch(identity, 'capabilities');
    if (!capabilities.includes('websocket')) {
      return new Response('WebSocket adapter is not enabled', { status: 400 });
    }
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, identity, params });
    try {
      await this.host.dispatch(identity, 'websocket.connect', { id, params });
    } catch (error) {
      server.close(1011, 'Connection failed');
      throw error;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async message(socket, message) {
    const { id, identity, params } = socket.deserializeAttachment();
    if (typeof message !== 'string') { socket.close(1003, 'Text messages only'); return; }
    if (new TextEncoder().encode(message).length > 4096 || message.length === 0) {
      socket.close(1009, 'Message must be 1 to 4096 bytes'); return;
    }
    try { await this.host.dispatch(identity, 'websocket.message', { id, message, params }); }
    catch (error) {
      console.error('PONDRO message failed', error);
      socket.close(1011, 'Message failed');
    }
  }

  async close(socket, code, reason) {
    const { id, identity, params } = socket.deserializeAttachment();
    try { await this.host.dispatch(identity, 'websocket.close', { id, code, reason, params }); }
    catch (error) { console.error('PONDRO close failed', error); }
    socket.close(code, reason);
  }

  async error(socket, error) {
    const { id, identity, params } = socket.deserializeAttachment();
    console.error('PONDRO WebSocket error', error);
    try { await this.host.dispatch(identity, 'websocket.error', { id, params }); }
    catch (dispatchError) { console.error('PONDRO error callback failed', dispatchError); }
    socket.close(1011, 'Socket failed');
  }
}
