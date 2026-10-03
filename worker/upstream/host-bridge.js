const RESULT_MAGIC = new Uint8Array([0x50, 0x48, 0x42, 0x31]); // PHB1
const CALL_MAGIC = new Uint8Array([0x50, 0x48, 0x43, 0x31]); // PHC1
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export const HostResultKind = Object.freeze({
  ok: 0,
  missing: 1,
  error: 2,
  bindingError: 3,
  argumentError: 4,
  protocolError: 5,
  hostStream: 6,
});

export class HostBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostBridgeError";
  }
}

export class HostBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostBindingError";
  }
}

export class HostArgumentError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "HostArgumentError";
  }
}

export class HostProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostProtocolError";
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Host bridge payload must be a Uint8Array or ArrayBuffer");
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function appendLengthPrefixed(parts, bytes) {
  const length = new Uint8Array(4);
  writeU32(length, 0, bytes.byteLength);
  parts.push(length, bytes);
}

export function encodeHostCall(operation, bindingName = "", args = []) {
  if (typeof operation !== "string" || operation.length === 0) {
    throw new TypeError("Host call operation must be a non-empty string");
  }
  if (typeof bindingName !== "string" || !Array.isArray(args)) {
    throw new TypeError("Host call binding and arguments are invalid");
  }
  const parts = [CALL_MAGIC];
  appendLengthPrefixed(parts, encoder.encode(operation));
  appendLengthPrefixed(parts, encoder.encode(bindingName));
  const count = new Uint8Array(4);
  writeU32(count, 0, args.length);
  parts.push(count);
  for (const arg of args) appendLengthPrefixed(parts, asBytes(arg));
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const frame = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.byteLength;
  }
  return frame;
}

export function decodeHostCall(frame) {
  const bytes = asBytes(frame);
  let offset = 0;
  const readBytes = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.byteLength) {
      throw new HostProtocolError("Truncated PicoRuby host call");
    }
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const readLengthPrefixed = () => readBytes(readU32(readBytes(4), 0));

  const magic = readBytes(CALL_MAGIC.byteLength);
  if (magic.some((value, index) => value !== CALL_MAGIC[index])) {
    throw new HostProtocolError("Unsupported PicoRuby host call");
  }
  let operation;
  let bindingName;
  try {
    operation = strictDecoder.decode(readLengthPrefixed());
    bindingName = strictDecoder.decode(readLengthPrefixed());
  } catch {
    throw new HostProtocolError("PicoRuby host call metadata must be valid UTF-8");
  }
  if (operation.length === 0) throw new HostProtocolError("PicoRuby host call operation is empty");
  const argumentCount = readU32(readBytes(4), 0);
  if (argumentCount > 16) throw new HostProtocolError("PicoRuby host call has too many arguments");
  const args = [];
  for (let index = 0; index < argumentCount; index++) args.push(readLengthPrefixed().slice());
  if (offset !== bytes.byteLength) throw new HostProtocolError("PicoRuby host call has trailing bytes");
  return { operation, bindingName, args };
}

export function encodeHostResult(kind, payload = new Uint8Array()) {
  if (!Number.isInteger(kind) || kind < HostResultKind.ok || kind > HostResultKind.hostStream) {
    throw new TypeError("Invalid host bridge result kind");
  }

  const bytes = asBytes(payload);
  const result = new Uint8Array(12 + bytes.byteLength);
  result.set(RESULT_MAGIC, 0);
  writeU32(result, 4, kind);
  writeU32(result, 8, bytes.byteLength);
  result.set(bytes, 12);
  return result;
}

export function decodeHostResult(frame) {
  const bytes = asBytes(frame);
  if (bytes.byteLength < 12) throw new HostBridgeError("Truncated PicoRuby host bridge result");

  for (let index = 0; index < RESULT_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== RESULT_MAGIC[index]) {
      throw new HostBridgeError("Unsupported PicoRuby host bridge result");
    }
  }

  const kind = readU32(bytes, 4);
  const length = readU32(bytes, 8);
  if (kind > HostResultKind.hostStream || length !== bytes.byteLength - 12) {
    throw new HostBridgeError("Invalid PicoRuby host bridge result");
  }
  return { kind, payload: bytes.slice(12) };
}

export async function captureHostCall(operation) {
  try {
    return encodeOperationResult(await operation());
  } catch (error) {
    return encodeHostError(error);
  }
}

export function captureHostCallSync(operation) {
  try {
    return encodeOperationResult(operation());
  } catch (error) {
    return encodeHostError(error);
  }
}

function encodeOperationResult(result) {
  if (!result || typeof result !== "object") {
    throw new HostProtocolError("Host bridge operation must return a result object");
  }
  try {
    return encodeHostResult(result.kind, result.payload);
  } catch (error) {
    throw new HostProtocolError(error instanceof Error ? error.message : String(error));
  }
}

function encodeHostError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let kind = HostResultKind.error;
  if (error instanceof HostBindingError) kind = HostResultKind.bindingError;
  if (error instanceof HostArgumentError) kind = HostResultKind.argumentError;
  if (error instanceof HostProtocolError) kind = HostResultKind.protocolError;
  return encodeHostResult(kind, encoder.encode(message));
}

export function hostOk(payload) {
  return { kind: HostResultKind.ok, payload: asBytes(payload) };
}

export function hostMissing() {
  return { kind: HostResultKind.missing, payload: new Uint8Array() };
}

export function hostErrorMessage(frame) {
  const result = decodeHostResult(frame);
  return result.kind >= HostResultKind.error && result.kind <= HostResultKind.protocolError ? decoder.decode(result.payload) : null;
}

export function utf8(value) {
  return encoder.encode(value);
}
