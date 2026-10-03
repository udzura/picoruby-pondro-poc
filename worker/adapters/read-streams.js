import { HostStreamRegistry } from '../upstream/runtime.js';

export const MAX_STREAM_BYTES = 1024 * 1024;
const READ_SIZE = 16 * 1024;
const join = (parts, size) => {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

// Reuse upstream handle allocation; reads return available bytes promptly,
// without waiting to fill the requested size. Only input streams are exposed.
export class ReadStreams extends HostStreamRegistry {
  async partial(entry, length) {
    if (entry.closed) return null;
    while (!entry.pending?.length) {
      if (entry.eof) return null;
      entry.reader ||= entry.stream.getReader();
      const { done, value } = await entry.reader.read();
      if (entry.closed) return null;
      if (done) {
        entry.eof = true;
        entry.reader.releaseLock();
        entry.reader = null;
        return null;
      }
      if (!(value instanceof Uint8Array)) throw new Error('Stream must yield byte chunks');
      entry.pending = value;
    }
    const chunk = entry.pending.slice(0, length);
    entry.pending = entry.pending.subarray(chunk.length);
    return chunk;
  }

  async invoke(operation, id, limit) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid stream handle');
    if (operation === 'close') { await this.close(id); return null; }
    const entry = this.streams.get(id);
    if (!entry) throw new Error('Unknown or expired stream handle');
    if (!Number.isSafeInteger(limit) || limit < (operation === 'read_partial' ? 1 : 0) || limit > MAX_STREAM_BYTES) {
      throw new Error('Invalid stream byte limit (maximum 1 MiB)');
    }
    const run = (entry.tail || Promise.resolve()).then(async () => {
      if (entry.closed) throw new Error('Stream is closed');
      try {
        if (operation === 'read_partial') {
          const chunk = await this.partial(entry, limit);
          return chunk === null ? null : { bytes: Array.from(chunk) };
        }
        const parts = [];
        let size = 0;
        while (true) {
          const chunk = await this.partial(entry, Math.min(READ_SIZE, limit - size + 1));
          if (chunk === null) break;
          let used = chunk;
          if (operation === 'readline') {
            const newline = chunk.indexOf(10);
            if (newline !== -1) {
              used = chunk.subarray(0, newline + 1);
              const suffix = chunk.subarray(newline + 1);
              entry.pending = join([suffix, entry.pending], suffix.length + entry.pending.length);
            }
          }
          size += used.length;
          if (size > limit) throw new Error('Stream exceeds max_bytes');
          parts.push(used);
          if (operation === 'readline' && used[used.length - 1] === 10) break;
        }
        if (operation === 'readline' && size === 0) return null;
        return { bytes: Array.from(join(parts, size)) };
      } catch (error) {
        await this.close(id);
        throw error;
      }
    });
    entry.tail = run.catch(() => {});
    return run;
  }

  async close(id) {
    const entry = this.streams.get(id);
    if (!entry) return;
    entry.closed = true;
    this.streams.delete(id);
    const reader = entry.reader;
    try {
      if (reader) await reader.cancel('Pondro stream closed');
      else if (!entry.eof) await entry.stream.cancel('Pondro stream closed');
    } catch { /* An errored stream is already stopped. */ }
    finally {
      if (reader) { try { reader.releaseLock(); } catch {} }
      entry.pending = null;
    }
  }

  async finishEvent() {
    await Promise.all([...this.streams.keys()].map(id => this.close(id)));
  }
}
