import {
  captureHostCall,
  captureHostCallSync,
  decodeHostCall,
  HostArgumentError,
  HostBindingError,
  HostProtocolError,
  HostResultKind,
  encodeHostResult,
  hostMissing,
  hostOk,
  utf8,
} from "./host-bridge.js";

const ABI_VERSION = 8;
const REQUEST_MAGIC = new Uint8Array([0x50, 0x52, 0x51, 0x32]); // PRQ2
const RESPONSE_MAGIC = new Uint8Array([0x50, 0x52, 0x52, 0x32]); // PRR2
const QUEUE_REQUEST_MAGIC = new Uint8Array([0x50, 0x43, 0x51, 0x31]); // PCQ1
const QUEUE_RESPONSE_MAGIC = new Uint8Array([0x50, 0x51, 0x52, 0x31]); // PQR1
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_QUEUE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_MESSAGE_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const missingEnvironmentValue = Symbol("missingEnvironmentValue");
const dispatchQueues = new WeakMap();
const hostContexts = new WeakMap();
const runtimeStreams = new WeakMap();
const runtimeOutputPumps = new WeakMap();

// A separate registry is created for every VM, even if callers reuse bindings.
export class HostStreamRegistry {
  constructor() {
    this.streams = new Map();
    this.outputs = new Map();
    this.nextId = 1;
    this.inputError = null;
  }

  register(stream) {
    if (!(stream instanceof ReadableStream) || stream.locked) {
      throw new HostProtocolError("Cloudflare AI streaming result must be an unlocked ReadableStream");
    }
    if (this.nextId > 0xffffffff) throw new HostProtocolError("Host stream handles exhausted");
    const id = this.nextId++;
    this.streams.set(id, { stream, reader: null, pending: null, eof: false });
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, id, true);
    return { kind: HostResultKind.hostStream, payload };
  }

  take(id) {
    const entry = this.streams.get(id);
    if (!entry || entry.reader || entry.eof) throw new HostProtocolError("Unknown or already transferred or consumed host stream handle");
    this.streams.delete(id);
    if (this.outputs.has(id)) this.outputs.get(id).transferred = true;
    return entry.stream;
  }

  createOutput() {
    const { readable, writable } = new TransformStream();
    const result = this.register(readable);
    const id = new DataView(result.payload.buffer).getUint32(0, true);
    this.outputs.set(id, { writer: writable.getWriter(), transferred: false });
    return result;
  }

  isOutput(id) {
    return this.outputs.has(id);
  }

  async writeOutput(id, bytes) {
    const output = this.outputs.get(id);
    if (!output) throw new HostProtocolError("Unknown output stream handle");
    await output.writer.write(bytes);
  }

  async closeOutput(id) {
    const output = this.outputs.get(id);
    if (!output) throw new HostProtocolError("Unknown output stream handle");
    this.outputs.delete(id);
    try { await output.writer.close(); } finally { output.writer.releaseLock(); }
  }

  registerInput(stream, maxBytes) {
    if (!(stream instanceof ReadableStream) || stream.locked) {
      throw new HostProtocolError("Cloudflare request body must be an unlocked ReadableStream");
    }
    if (this.nextId > 0xffffffff) throw new HostProtocolError("Host stream handles exhausted");
    const id = this.nextId++;
    this.streams.set(id, {
      stream, reader: null, pending: null, eof: false, inputBytes: 0, maxBytes,
    });
    return id;
  }

  async read(id, length, input) {
    const entry = this.streams.get(id);
    if (!entry) {
      throw new HostProtocolError(input ? "Unknown or transferred input stream handle" : "Unknown or consumed host stream handle");
    }
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new HostArgumentError(input ? "Cloudflare input read length must be positive" : "Cloudflare stream read length must be positive");
    }
    if (entry.eof) return null;
    const reader = entry.reader ||= entry.stream.getReader();
    const chunks = [];
    let total = 0;
    while (total < length) {
      let value = entry.pending;
      entry.pending = null;
      if (!value) {
        let next;
        try {
          next = await reader.read();
        } catch (error) {
          if (input) this.inputError = error;
          throw error;
        }
        if (next.done) {
          reader.releaseLock();
          entry.eof = true;
          break;
        }
        value = next.value;
        if (input) entry.inputBytes += value.byteLength;
        if (input && entry.maxBytes !== undefined && entry.inputBytes > entry.maxBytes) {
          const error = new RequestBodyTooLargeError(entry.maxBytes);
          if (input) this.inputError = error;
          entry.eof = true;
          await reader.cancel("PicoRuby request body limit exceeded");
          reader.releaseLock();
          throw error;
        }
      }
      const chunk = value.subarray(0, length - total);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength !== value.byteLength) entry.pending = value.subarray(chunk.byteLength);
    }
    if (total === 0) return null;
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  async readInput(id, length) {
    return await this.read(id, length, true);
  }

  async readStream(id, length) {
    const entry = this.streams.get(id);
    if (!entry) throw new HostProtocolError("Unknown or consumed host stream handle");
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new HostArgumentError("Cloudflare stream read length must be positive");
    }
    if (entry.eof) return null;
    const reader = entry.reader ||= entry.stream.getReader();
    let value = entry.pending;
    entry.pending = null;
    while (!value || value.byteLength === 0) {
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        entry.eof = true;
        return null;
      }
      value = next.value;
    }
    const chunk = value.subarray(0, length);
    if (chunk.byteLength < value.byteLength) entry.pending = value.subarray(chunk.byteLength);
    return chunk;
  }

  discard() {
    for (const [id, output] of this.outputs) {
      if (output.transferred) continue;
      output.writer.abort("Output stream was not completed").catch(() => {});
      this.outputs.delete(id);
    }
    for (const { stream, reader } of this.streams.values()) {
      // Do not delay the response on an upstream cancellation promise.
      (reader ? reader.cancel("Host stream was not returned") : stream.cancel("Host stream was not returned")).catch(() => {});
    }
    this.streams.clear();
  }

  discardOutputs() {
    for (const output of this.outputs.values()) {
      output.writer.abort("Ruby output stream ended").catch(() => {});
    }
    this.outputs.clear();
  }

  takeInputError() {
    const error = this.inputError;
    this.inputError = null;
    return error;
  }
}

function responseStream(source, signal) {
  const reader = source.getReader();
  let finished = false;
  let controller;
  const finish = () => {
    finished = true;
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const cancel = (reason) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    return reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
  };
  const abort = () => {
    if (finished) return;
    controller.error(signal.reason);
    void cancel(signal.reason);
  };
  return new ReadableStream({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull() {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (finished) return;
        controller.error(error);
        finish();
      }
    },
    cancel,
  }, { highWaterMark: 0 });
}

export class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

async function unavailableHostBridge() {
  return await captureHostCall(async () => {
    throw new HostBindingError("PicoRuby Worker binding is not configured");
  });
}

function unavailableEnvironmentBridge() {
  return encodeHostResult(
    HostResultKind.bindingError,
    utf8("PicoRuby Worker environment binding is not configured"),
  );
}

const defaultRuntimeBindings = {
  picorbWorkerJspiAdd: async (left, right) => {
    await Promise.resolve();
    return left + right;
  },
  picorbWorkerHostCallBridge: unavailableHostBridge,
  picorbWorkerEnvGetBridge: unavailableEnvironmentBridge,
  picorbWorkerEnvBindingTypeBridge: unavailableEnvironmentBridge,
};

export function mergeBindings(...bindingSets) {
  const bindings = {};

  for (const bindingSet of bindingSets) {
    if (!bindingSet || typeof bindingSet !== "object" || Array.isArray(bindingSet)) {
      throw new TypeError("PicoRuby Worker bindings must be an object");
    }

    for (const [name, callback] of Object.entries(bindingSet)) {
      if (!name.startsWith("picorbWorker") || typeof callback !== "function") {
        throw new TypeError(`Invalid PicoRuby Worker binding: ${name}`);
      }
      if (Object.hasOwn(bindings, name)) {
        throw new Error(`Duplicate PicoRuby Worker binding: ${name}`);
      }
      bindings[name] = callback;
    }
  }

  return bindings;
}

export function createCloudflareKvBindings(env, bindingTypes = {}) {
  const types = normalizeBindingTypes(bindingTypes);
  const get = async (bindingName, key) => {
    const namespace = getKvNamespace(env, types, bindingName);
    const value = await namespace.get(decodeKvKey(key), "arrayBuffer");
    return value === null ? null : new Uint8Array(value);
  };

  const put = async (bindingName, key, value, options = {}) => {
    const namespace = getKvNamespace(env, types, bindingName);
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    await namespace.put(decodeKvKey(key), bytes.buffer, options);
  };

  return {
    picorbWorkerKvGetBridge: async (bindingName, key) => {
      return await captureHostCall(async () => {
        const value = await get(bindingName, key);
        return value === null ? hostMissing() : hostOk(value);
      });
    },
    picorbWorkerKvPutBridge: async (bindingName, key, value, optionsJson = "{}") => {
      return await captureHostCall(async () => {
        const options = parseKvPutOptions(optionsJson);
        await put(bindingName, key, value, options);
        return hostOk(new Uint8Array());
      });
    },
  };
}

function decodeKvKey(key) {
  if (typeof key === "string") return key;
  try {
    return strictDecoder.decode(key);
  } catch {
    throw new HostArgumentError("Cloudflare KV key must be valid UTF-8");
  }
}

function parseKvPutOptions(optionsJson) {
  let options;
  try {
    options = JSON.parse(optionsJson);
  } catch {
    throw new HostProtocolError("Cloudflare KV put options contain invalid JSON");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new HostArgumentError("Cloudflare KV put options must be a JSON object");
  }
  for (const name of Object.keys(options)) {
    if (name !== "ttl") throw new HostArgumentError(`Unknown Cloudflare KV put option: ${name}`);
  }
  if (!Object.hasOwn(options, "ttl")) return {};
  if (!Number.isSafeInteger(options.ttl) || options.ttl < 60) {
    throw new HostArgumentError("Cloudflare KV ttl must be a safe integer of at least 60 seconds");
  }
  return { expirationTtl: options.ttl };
}

export function createCloudflareQueueBindings(env, bindingTypes = {}) {
  const types = normalizeBindingTypes(bindingTypes);
  return {
    picorbWorkerQueueSendBridge: async (bindingName, message) => {
      return await captureHostCall(async () => {
        const queue = getQueue(env, types, bindingName);
        const body = decodeQueueMessage(message);
        await queue.send(body, { contentType: "text" });
        return hostOk(new Uint8Array());
      });
    },
  };
}

export function createCloudflareDurableObjectBindings(env, bindingTypes = {}) {
  const types = normalizeBindingTypes(bindingTypes);
  return {
    picorbWorkerDurableObjectGetBridge: async (bindingName, objectName) => {
      return await captureHostCall(async () => {
        const stub = getDurableObjectStub(env, types, bindingName, objectName);
        const json = await stub.get();
        if (json === null || json === undefined) return hostMissing();
        validateDurableObjectJson(json);
        return hostOk(utf8(json));
      });
    },
    picorbWorkerDurableObjectPutBridge: async (bindingName, objectName, json) => {
      return await captureHostCall(async () => {
        const stub = getDurableObjectStub(env, types, bindingName, objectName);
        validateDurableObjectJson(json);
        await stub.put(json);
        return hostOk(new Uint8Array());
      });
    },
  };
}

function getDurableObjectStub(env, bindingTypes, bindingName, objectName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare Durable Object binding name must be a non-empty string");
  }
  if (typeof objectName !== "string" || objectName.length === 0) {
    throw new HostArgumentError("Cloudflare Durable Object name must be a non-empty string");
  }

  requireBindingType(bindingTypes, bindingName, "durable_object");
  const namespace = env[bindingName];
  if (!namespace || typeof namespace.getByName !== "function") {
    throw new HostBindingError(`Cloudflare Durable Object binding ${bindingName} is not configured`);
  }
  const stub = namespace.getByName(objectName);
  if (!stub || typeof stub.get !== "function" || typeof stub.put !== "function") {
    throw new HostBindingError(`Cloudflare Durable Object ${bindingName} does not provide get/put RPC methods`);
  }
  return stub;
}

function validateDurableObjectJson(json) {
  if (typeof json !== "string") {
    throw new HostProtocolError("Cloudflare Durable Object value must be a JSON string");
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HostProtocolError("Cloudflare Durable Object value contains invalid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new HostProtocolError("Cloudflare Durable Object value must encode a JSON object or array");
  }
}

export function createCloudflareD1Bindings(env, bindingTypes = {}) {
  const types = normalizeBindingTypes(bindingTypes);
  return {
    picorbWorkerD1Bridge: async (bindingName, requestJson) => {
      return await captureHostCall(async () => {
        const database = getD1Database(env, types, bindingName);
        const request = parseD1Request(requestJson);
        const result = await executeD1Request(database, request);
        validateJsonValue(result, "Cloudflare D1");
        return hostOk(utf8(JSON.stringify(result)));
      });
    },
  };
}

function getD1Database(env, bindingTypes, bindingName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare D1 binding name must be a non-empty string");
  }

  requireBindingType(bindingTypes, bindingName, "d1");
  const database = env[bindingName];
  if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
    throw new HostBindingError(`Cloudflare D1 binding ${bindingName} is not configured`);
  }
  return database;
}

function parseD1Request(requestJson) {
  if (typeof requestJson !== "string") {
    throw new HostProtocolError("Cloudflare D1 request must be a JSON string");
  }
  let request;
  try {
    request = JSON.parse(requestJson);
  } catch {
    throw new HostProtocolError("Cloudflare D1 request contains invalid JSON");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new HostProtocolError("Cloudflare D1 request must be an object");
  }

  if (request.operation === "batch") {
    requireD1Fields(request, ["operation", "statements"]);
    if (!Array.isArray(request.statements) || request.statements.length === 0) {
      throw new HostProtocolError("Cloudflare D1 batch requires at least one statement");
    }
    return {
      operation: "batch",
      statements: request.statements.map(validateD1StatementSpec),
    };
  }

  if (!["run", "first", "raw"].includes(request.operation)) {
    throw new HostProtocolError(`Unsupported Cloudflare D1 operation: ${request.operation}`);
  }
  const fields = ["operation", "sql", "params"];
  if (request.operation === "first") fields.push("column");
  if (request.operation === "raw") fields.push("columnNames");
  requireD1Fields(request, fields);

  const statement = validateD1StatementSpec({ sql: request.sql, params: request.params });
  if (request.operation === "first" && request.column !== null &&
      (typeof request.column !== "string" || request.column.length === 0)) {
    throw new HostProtocolError("Cloudflare D1 first column must be null or a non-empty string");
  }
  if (request.operation === "raw" && typeof request.columnNames !== "boolean") {
    throw new HostProtocolError("Cloudflare D1 raw columnNames must be boolean");
  }
  return { ...request, ...statement };
}

function requireD1Fields(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new HostProtocolError("Cloudflare D1 request contains unsupported or missing fields");
  }
}

function validateD1StatementSpec(statement) {
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) {
    throw new HostProtocolError("Cloudflare D1 statement must be an object");
  }
  requireD1Fields(statement, ["sql", "params"]);
  if (typeof statement.sql !== "string" || statement.sql.length === 0 || statement.sql.includes("\0")) {
    throw new HostArgumentError("Cloudflare D1 SQL must be a non-empty string without NUL bytes");
  }
  if (!Array.isArray(statement.params)) {
    throw new HostProtocolError("Cloudflare D1 params must be an array");
  }
  statement.params.forEach(validateD1Parameter);
  return { sql: statement.sql, params: statement.params };
}

function validateD1Parameter(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  throw new HostArgumentError("Cloudflare D1 params must contain only JSON scalar values and safe integers");
}

function prepareD1Statement(database, spec) {
  let statement = database.prepare(spec.sql);
  if (!statement || typeof statement.run !== "function" || typeof statement.first !== "function" ||
      typeof statement.raw !== "function" || typeof statement.bind !== "function") {
    throw new HostBindingError("Cloudflare D1 prepare did not return a prepared statement");
  }
  if (spec.params.length > 0) statement = statement.bind(...spec.params);
  return statement;
}

async function executeD1Request(database, request) {
  if (request.operation === "batch") {
    return await database.batch(request.statements.map(spec => prepareD1Statement(database, spec)));
  }

  const statement = prepareD1Statement(database, request);
  if (request.operation === "run") return await statement.run();
  if (request.operation === "first") {
    return request.column === null ? await statement.first() : await statement.first(request.column);
  }
  return request.columnNames
    ? await statement.raw({ columnNames: true })
    : await statement.raw();
}

function validateJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new HostProtocolError(`${label} returned a number outside the supported JSON range`);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    throw new HostProtocolError(`${label} returned a non-JSON value`);
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HostProtocolError(`${label} returned a non-JSON object`);
  }
  if (ancestors.has(value)) {
    throw new HostProtocolError(`${label} returned a circular value`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => validateJsonValue(item, label, ancestors));
  } else {
    for (const item of Object.values(value)) validateJsonValue(item, label, ancestors);
  }
  ancestors.delete(value);
}

async function executeAiRun(env, bindingTypes, bindingName, model, inputJson, optionsJson, streams) {
  return await captureHostCall(async () => {
    if (typeof bindingName !== "string" || bindingName.length === 0) {
      throw new HostArgumentError("Cloudflare AI binding name must be a non-empty string");
    }
    if (typeof model !== "string" || model.length === 0 || model.includes("\0")) {
      throw new HostArgumentError("Cloudflare AI model must be a non-empty string without NUL bytes");
    }
    requireBindingType(bindingTypes, bindingName, "ai");
    const ai = env[bindingName];
    if (!ai || typeof ai.run !== "function") {
      throw new HostBindingError(`Cloudflare AI binding ${bindingName} is not configured`);
    }

    let input;
    try {
      input = JSON.parse(inputJson);
    } catch {
      throw new HostProtocolError("Cloudflare AI input contains invalid JSON");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HostArgumentError("Cloudflare AI input must be a JSON object");
    }
    validateJsonValue(input, "Cloudflare AI input");

    let options;
    try {
      options = JSON.parse(optionsJson);
    } catch {
      throw new HostProtocolError("Cloudflare AI options contains invalid JSON");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new HostArgumentError("Cloudflare AI options must be a JSON object");
    }
    validateJsonValue(options, "Cloudflare AI options");

    const result = await ai.run(model, input, options);
    if (input.stream === true) return streams.register(result);
    validateJsonValue(result, "Cloudflare AI");
    return hostOk(utf8(JSON.stringify(result)));
  });
}

function parseVectorizeJson(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HostProtocolError("Cloudflare Vectorize request contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostArgumentError("Cloudflare Vectorize request must be a JSON object");
  }
  return value;
}

function getVectorizeIndex(env, bindingTypes, bindingName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare Vectorize binding name must be a non-empty string");
  }
  requireBindingType(bindingTypes, bindingName, "vectorize");
  const index = env[bindingName];
  if (!index || typeof index.query !== "function") {
    throw new HostBindingError(`Cloudflare Vectorize binding ${bindingName} is not configured`);
  }
  return index;
}

function validateVector(values, label) {
  if (!Array.isArray(values) || values.length === 0 ||
      values.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new HostArgumentError(`${label} must be a non-empty Array of finite numbers`);
  }
}

function validateVectorizeOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HostArgumentError("Cloudflare Vectorize query options must be a JSON object");
  }
  const allowed = new Set(["topK", "returnValues", "returnMetadata", "namespace", "filter"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new HostArgumentError(`Unknown Cloudflare Vectorize query option: ${key}`);
  }
  if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100) {
    throw new HostArgumentError("Cloudflare Vectorize topK must be an Integer between 1 and 100");
  }
  if (typeof options.returnValues !== "boolean") {
    throw new HostArgumentError("Cloudflare Vectorize returnValues must be boolean");
  }
  if (!["none", "indexed", "all"].includes(options.returnMetadata)) {
    throw new HostArgumentError("Cloudflare Vectorize returnMetadata must be none, indexed, or all");
  }
  if ((options.returnValues || options.returnMetadata === "all") && options.topK > 50) {
    throw new HostArgumentError("Cloudflare Vectorize topK must not exceed 50 when returning values or all metadata");
  }
  if (options.namespace !== undefined &&
      (typeof options.namespace !== "string" || options.namespace.length === 0)) {
    throw new HostArgumentError("Cloudflare Vectorize namespace must be a non-empty string");
  }
  if (options.filter !== undefined &&
      (!options.filter || typeof options.filter !== "object" || Array.isArray(options.filter))) {
    throw new HostArgumentError("Cloudflare Vectorize filter must be a JSON object");
  }
  validateJsonValue(options, "Cloudflare Vectorize query options");
}

function validateVectorizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 ||
      ids.some(id => typeof id !== "string" || id.length === 0)) {
    throw new HostArgumentError("Cloudflare Vectorize ids must be a non-empty Array of non-empty strings");
  }
}

function validateVectorizeVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new HostArgumentError("Cloudflare Vectorize vectors must be a non-empty Array");
  }
  for (const vector of vectors) {
    if (!vector || typeof vector !== "object" || Array.isArray(vector) ||
        typeof vector.id !== "string" || vector.id.length === 0) {
      throw new HostArgumentError("Each Cloudflare Vectorize vector must have a non-empty string id");
    }
    validateVector(vector.values, "Cloudflare Vectorize vector values");
    if (vector.namespace !== undefined &&
        (typeof vector.namespace !== "string" || vector.namespace.length === 0)) {
      throw new HostArgumentError("Cloudflare Vectorize vector namespace must be a non-empty string");
    }
    if (vector.metadata !== undefined &&
        (!vector.metadata || typeof vector.metadata !== "object" || Array.isArray(vector.metadata))) {
      throw new HostArgumentError("Cloudflare Vectorize vector metadata must be a JSON object");
    }
    validateJsonValue(vector, "Cloudflare Vectorize vector");
  }
}

async function executeVectorize(env, bindingTypes, bindingName, operation, requestJson) {
  return await captureHostCall(async () => {
    const index = getVectorizeIndex(env, bindingTypes, bindingName);
    const request = parseVectorizeJson(requestJson);
    let result;
    if (operation === "query" || operation === "query_by_id") {
      validateVectorizeOptions(request.options);
      if (operation === "query") {
        validateVector(request.vector, "Cloudflare Vectorize query vector");
        result = await index.query(request.vector, request.options);
      } else {
        if (typeof request.id !== "string" || request.id.length === 0) {
          throw new HostArgumentError("Cloudflare Vectorize id must be a non-empty string");
        }
        if (typeof index.queryById !== "function") {
          throw new HostBindingError(`Cloudflare Vectorize binding ${bindingName} does not support queryById`);
        }
        result = await index.queryById(request.id, request.options);
      }
    } else if (operation === "insert" || operation === "upsert") {
      validateVectorizeVectors(request.vectors);
      if (typeof index[operation] !== "function") {
        throw new HostBindingError(`Cloudflare Vectorize binding ${bindingName} does not support ${operation}`);
      }
      result = await index[operation](request.vectors);
    } else if (operation === "get_by_ids" || operation === "delete_by_ids") {
      validateVectorizeIds(request.ids);
      const method = operation === "get_by_ids" ? "getByIds" : "deleteByIds";
      if (typeof index[method] !== "function") {
        throw new HostBindingError(`Cloudflare Vectorize binding ${bindingName} does not support ${method}`);
      }
      result = await index[method](request.ids);
    } else {
      if (typeof index.describe !== "function") {
        throw new HostBindingError(`Cloudflare Vectorize binding ${bindingName} does not support describe`);
      }
      result = await index.describe();
    }
    validateJsonValue(result, "Cloudflare Vectorize");
    return hostOk(utf8(JSON.stringify(result)));
  });
}

function decodeQueueMessage(message) {
  try {
    return strictDecoder.decode(message);
  } catch {
    throw new HostArgumentError("Cloudflare Queue message must be valid UTF-8");
  }
}

function getKvNamespace(env, bindingTypes, bindingName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare KV binding name must be a non-empty string");
  }

  requireBindingType(bindingTypes, bindingName, "kv");
  const namespace = env[bindingName];
  if (!namespace || typeof namespace.get !== "function" || typeof namespace.put !== "function") {
    throw new HostBindingError(`Cloudflare KV binding ${bindingName} is not configured`);
  }
  return namespace;
}

function getQueue(env, bindingTypes, bindingName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare Queue binding name must be a non-empty string");
  }

  requireBindingType(bindingTypes, bindingName, "queue");
  const queue = env[bindingName];
  if (!queue || typeof queue.send !== "function") {
    throw new HostBindingError(`Cloudflare Queue binding ${bindingName} is not configured`);
  }
  return queue;
}

function getR2Bucket(env, bindingTypes, bindingName) {
  if (typeof bindingName !== "string" || bindingName.length === 0) {
    throw new HostArgumentError("Cloudflare R2 binding name must be a non-empty string");
  }
  requireBindingType(bindingTypes, bindingName, "r2");
  const bucket = env[bindingName];
  if (!bucket || typeof bucket.head !== "function" || typeof bucket.get !== "function" ||
      typeof bucket.put !== "function" || typeof bucket.delete !== "function" ||
      typeof bucket.list !== "function") {
    throw new HostBindingError(`Cloudflare R2 binding ${bindingName} is not configured`);
  }
  return bucket;
}

function decodeR2Key(key) {
  try {
    return strictDecoder.decode(key);
  } catch {
    throw new HostArgumentError("Cloudflare R2 key must be valid UTF-8");
  }
}

function parseR2Options(json, operation) {
  let options;
  try {
    options = JSON.parse(json);
  } catch {
    throw new HostProtocolError(`Cloudflare R2 ${operation} options contain invalid JSON`);
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HostArgumentError(`Cloudflare R2 ${operation} options must be a JSON object`);
  }
  validateJsonValue(options, `Cloudflare R2 ${operation} options`);
  return options;
}

function serializeR2Object(object) {
  if (!object || typeof object !== "object" || typeof object.key !== "string") {
    throw new HostProtocolError("Cloudflare R2 returned an invalid object");
  }
  const result = { key: object.key };
  for (const key of ["version", "size", "etag", "httpEtag", "httpMetadata", "customMetadata", "range", "storageClass"]) {
    if (object[key] !== undefined) result[key] = object[key];
  }
  if (object.uploaded !== undefined) result.uploaded = object.uploaded instanceof Date
    ? object.uploaded.toISOString() : object.uploaded;
  validateJsonValue(result, "Cloudflare R2 object");
  return result;
}

async function executeR2(env, bindingTypes, bindingName, operation, args, streams) {
  return await captureHostCall(async () => {
    const bucket = getR2Bucket(env, bindingTypes, bindingName);
    if (operation === "head") {
      const object = await bucket.head(decodeR2Key(args[0]));
      return object === null ? hostMissing() : hostOk(utf8(JSON.stringify(serializeR2Object(object))));
    }
    if (operation === "get") {
      const object = await bucket.get(decodeR2Key(args[0]), parseR2Options(decodeHostCallText(args[1]), "get"));
      if (object === null) return hostMissing();
      const result = { object: serializeR2Object(object) };
      if (object.body !== undefined) {
        const stream = streams.register(object.body);
        result.streamId = new DataView(stream.payload.buffer, stream.payload.byteOffset, 4).getUint32(0, true);
      }
      return hostOk(utf8(JSON.stringify(result)));
    }
    if (operation === "put" || operation === "put_input") {
      const value = operation === "put"
        ? args[1]
        : streams.take(Number(decodeHostCallText(args[1])));
      const optionsArg = operation === "put" ? args[2] : args[2];
      const object = await bucket.put(decodeR2Key(args[0]), value, parseR2Options(decodeHostCallText(optionsArg), "put"));
      return object === null ? hostMissing() : hostOk(utf8(JSON.stringify(serializeR2Object(object))));
    }
    if (operation === "delete") {
      let keys;
      try { keys = JSON.parse(decodeHostCallText(args[0])); } catch { throw new HostProtocolError("Cloudflare R2 delete keys contain invalid JSON"); }
      if (!Array.isArray(keys) || keys.length === 0 || keys.some(key => typeof key !== "string")) {
        throw new HostArgumentError("Cloudflare R2 delete keys must be a non-empty Array of strings");
      }
      await bucket.delete(keys);
      return hostOk(new Uint8Array());
    }
    const listed = await bucket.list(parseR2Options(decodeHostCallText(args[0]), "list"));
    if (!listed || !Array.isArray(listed.objects) || typeof listed.truncated !== "boolean") {
      throw new HostProtocolError("Cloudflare R2 returned an invalid list result");
    }
    return hostOk(utf8(JSON.stringify({
      objects: listed.objects.map(serializeR2Object), truncated: listed.truncated,
      cursor: listed.cursor, delimitedPrefixes: listed.delimitedPrefixes || [],
    })));
  });
}

function isJsonValue(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return true;
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function isResourceBinding(value) {
  return value && typeof value === "object" && (
    typeof value.get === "function" ||
    typeof value.put === "function" ||
    typeof value.send === "function" ||
    typeof value.run === "function" ||
    typeof value.query === "function" ||
    typeof value.prepare === "function" ||
    typeof value.fetch === "function" ||
    typeof value.getByName === "function"
  );
}

function readEnvironmentValue(env, key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new HostArgumentError("Environment variable name must be a non-empty string");
  }

  const value = env[key];
  if (value === undefined) return missingEnvironmentValue;
  if (typeof value === "string") return value;
  if (isResourceBinding(value)) return missingEnvironmentValue;
  if (isJsonValue(value)) return value;
  return missingEnvironmentValue;
}

function readBindingType(env, bindingTypes, key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new HostArgumentError("Cloudflare binding name must be a non-empty string");
  }

  return env[key] === undefined ? null : bindingTypes[key] ?? null;
}

export function createEnvironmentBindings(env, bindingTypes = {}) {
  const types = normalizeBindingTypes(bindingTypes);
  return {
    picorbWorkerEnvGetBridge: (key) => {
      return captureHostCallSync(() => {
        const value = readEnvironmentValue(env, key);
        return value === missingEnvironmentValue
          ? hostMissing()
          : hostOk(utf8(JSON.stringify(value)));
      });
    },
    picorbWorkerEnvBindingTypeBridge: (key) => {
      return captureHostCallSync(() => {
        const type = readBindingType(env, types, key);
        return type === null ? hostMissing() : hostOk(utf8(type));
      });
    },
  };
}

export function createFetchBindings(fetcher = (...args) => globalThis.fetch(...args)) {
  return {
    picorbWorkerFetchBridge: async (url, optionsJson = "{}") => captureHostCall(async () => {
      let options;
      try {
        options = JSON.parse(optionsJson);
      } catch {
        throw new HostProtocolError("Cloudflare fetch options contain invalid JSON");
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new HostArgumentError("Cloudflare fetch options must be an object");
      }
      if (Object.keys(options).some(key => !["method", "headers", "body"].includes(key))) {
        throw new HostArgumentError("Cloudflare fetch options contain an unsupported field");
      }
      if (options.method !== undefined && typeof options.method !== "string") {
        throw new HostArgumentError("Cloudflare fetch method must be a string");
      }
      if (options.body !== undefined && typeof options.body !== "string") {
        throw new HostArgumentError("Cloudflare fetch body must be a string");
      }
      if (options.headers !== undefined && (!options.headers || typeof options.headers !== "object" ||
          Array.isArray(options.headers) || Object.values(options.headers).some(value => typeof value !== "string"))) {
        throw new HostArgumentError("Cloudflare fetch headers must be an object with string values");
      }
      let target;
      try {
        if (typeof url !== "string" || url.includes("\0")) throw new Error();
        target = new URL(url);
      } catch {
        throw new HostArgumentError("Cloudflare fetch URL must be a valid absolute URL without NUL bytes");
      }
      if (!["http:", "https:"].includes(target.protocol)) {
        throw new HostArgumentError("Cloudflare fetch URL must use HTTP or HTTPS");
      }
      if (target.username || target.password) {
        throw new HostArgumentError("Cloudflare fetch URL must not contain credentials");
      }
      let request;
      try {
        // workerd does not support redirect: "error". Reject redirects below instead.
        request = new Request(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(10000) });
      } catch {
        throw new HostArgumentError("Cloudflare fetch request construction failed; check method, headers and body compatibility");
      }
      let response;
      try {
        response = await fetcher(request);
      } catch {
        throw new Error("Cloudflare fetch network request failed or timed out");
      }
      if (response.status >= 300 && response.status < 400) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new Error(`Cloudflare fetch redirect response rejected (HTTP ${response.status})`);
      }
      let bytes;
      try {
        bytes = await readRequestBody(response, 1024 * 1024);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          throw new Error("Cloudflare fetch response body exceeds the 1 MiB limit");
        }
        throw new Error("Cloudflare fetch response body read failed or timed out");
      }
      let body;
      try {
        body = strictDecoder.decode(bytes);
      } catch {
        throw new HostProtocolError("Cloudflare fetch response body is not valid UTF-8");
      }
      return hostOk(utf8(JSON.stringify({
        status: response.status, headers: Object.fromEntries(response.headers), body,
      })));
    }),
  };
}

export function createCloudflareBindings(env, bindingTypes, { plugins = [] } = {}) {
  const streams = new HostStreamRegistry();
  const types = normalizeBindingTypes(bindingTypes);
  const operationBindings = mergeBindings(
    createCloudflareKvBindings(env, types),
    createCloudflareQueueBindings(env, types),
    createCloudflareDurableObjectBindings(env, types),
    createCloudflareD1Bindings(env, types),
    createFetchBindings(),
  );
  const operations = {
    "kv.get": ([key], bindingName) => operationBindings.picorbWorkerKvGetBridge(bindingName, key),
    "kv.put": ([key, value, options], bindingName) => operationBindings.picorbWorkerKvPutBridge(
      bindingName, key, value, decodeHostCallText(options),
    ),
    "queue.send": ([message], bindingName) => operationBindings.picorbWorkerQueueSendBridge(
      bindingName, message,
    ),
    "durable_object.get": ([name], bindingName) => operationBindings.picorbWorkerDurableObjectGetBridge(
      bindingName, decodeHostCallText(name),
    ),
    "durable_object.put": ([name, json], bindingName) => operationBindings.picorbWorkerDurableObjectPutBridge(
      bindingName, decodeHostCallText(name), decodeHostCallText(json),
    ),
    "d1.execute": ([request], bindingName) => operationBindings.picorbWorkerD1Bridge(
      bindingName, decodeHostCallText(request),
    ),
    "input.read": async ([id, length], bindingName) => captureHostCall(async () => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare input does not use a binding");
      const streamId = Number(decodeHostCallText(id));
      const bytes = await streams.readInput(streamId, Number(decodeHostCallText(length)));
      return bytes === null ? hostMissing() : hostOk(bytes);
    }),
    "stream.read": async ([id, length], bindingName) => captureHostCall(async () => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare stream does not use a binding");
      const streamId = Number(decodeHostCallText(id));
      const bytes = await streams.readStream(streamId, Number(decodeHostCallText(length)));
      return bytes === null ? hostMissing() : hostOk(bytes);
    }),
    "output.create": ([], bindingName) => captureHostCall(() => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare output does not use a binding");
      return streams.createOutput();
    }),
    "output.write": async ([id, bytes], bindingName) => captureHostCall(async () => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare output does not use a binding");
      await streams.writeOutput(Number(decodeHostCallText(id)), bytes);
      return hostOk(new Uint8Array());
    }),
    "output.close": async ([id], bindingName) => captureHostCall(async () => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare output does not use a binding");
      await streams.closeOutput(Number(decodeHostCallText(id)));
      return hostOk(new Uint8Array());
    }),
    "r2.head": ([key], bindingName) => executeR2(env, types, bindingName, "head", [key], streams),
    "r2.get": ([key, options], bindingName) => executeR2(env, types, bindingName, "get", [key, options], streams),
    "r2.put": ([key, value, options], bindingName) => executeR2(env, types, bindingName, "put", [key, value, options], streams),
    "r2.put_input": ([key, inputId, options], bindingName) => executeR2(env, types, bindingName, "put_input", [key, inputId, options], streams),
    "r2.delete": ([keys], bindingName) => executeR2(env, types, bindingName, "delete", [keys], streams),
    "r2.list": ([options], bindingName) => executeR2(env, types, bindingName, "list", [options], streams),
    "ai.run": ([model, input, options], bindingName) => executeAiRun(
      env, types, bindingName, decodeHostCallText(model), decodeHostCallText(input), decodeHostCallText(options), streams,
    ),
    "vectorize.query": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "query", decodeHostCallText(request),
    ),
    "vectorize.query_by_id": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "query_by_id", decodeHostCallText(request),
    ),
    "vectorize.insert": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "insert", decodeHostCallText(request),
    ),
    "vectorize.upsert": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "upsert", decodeHostCallText(request),
    ),
    "vectorize.get_by_ids": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "get_by_ids", decodeHostCallText(request),
    ),
    "vectorize.delete_by_ids": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "delete_by_ids", decodeHostCallText(request),
    ),
    "vectorize.describe": ([request], bindingName) => executeVectorize(
      env, types, bindingName, "describe", decodeHostCallText(request),
    ),
    "fetch": ([url, options], bindingName) => {
      if (bindingName !== "") return protocolErrorFrame("Cloudflare fetch does not use a binding");
      return operationBindings.picorbWorkerFetchBridge(
        decodeHostCallText(url), decodeHostCallText(options),
      );
    },
  };
  const arities = {
    "kv.get": 1,
    "kv.put": 3,
    "queue.send": 1,
    "durable_object.get": 1,
    "durable_object.put": 2,
    "d1.execute": 1,
    "input.read": 2,
    "stream.read": 2,
    "output.create": 0,
    "output.write": 2,
    "output.close": 1,
    "r2.head": 1,
    "r2.get": 2,
    "r2.put": 3,
    "r2.put_input": 3,
    "r2.delete": 1,
    "r2.list": 1,
    "ai.run": 3,
    "vectorize.query": 1,
    "vectorize.query_by_id": 1,
    "vectorize.insert": 1,
    "vectorize.upsert": 1,
    "vectorize.get_by_ids": 1,
    "vectorize.delete_by_ids": 1,
    "vectorize.describe": 1,
    "fetch": 2,
  };
  for (const plugin of plugins) {
    if (!plugin || !/^[a-z][a-z0-9.-]*$/.test(plugin.id) || typeof plugin.create !== "function") {
      throw new TypeError("Invalid Worker plugin");
    }
    const handlers = plugin.create(env, {
      text: decodeHostCallText,
      json(value) {
        validateJsonValue(value, "Worker plugin result");
        return hostOk(utf8(JSON.stringify(value)));
      },
      stream: source => streams.register(source),
      argumentError: message => new HostArgumentError(message),
      bindingError: message => new HostBindingError(message),
    });
    for (const [name, handler] of Object.entries(handlers)) {
      if (!name.startsWith(`${plugin.id}.`) || Object.hasOwn(operations, name) ||
          !Number.isInteger(handler?.arity) || handler.arity < 0 || handler.arity > 16 ||
          typeof handler.call !== "function") {
        throw new TypeError(`Invalid or duplicate Worker plugin operation: ${name}`);
      }
      operations[name] = (args, bindingName) => captureHostCall(() => {
        if (bindingName !== "") throw new HostArgumentError("Worker plugin operations do not use a Cloudflare binding");
        return handler.call(args);
      });
      arities[name] = handler.arity;
    }
  }
  const bindings = mergeBindings(
    {
      picorbWorkerHostCallBridge: async (frame) => {
        let call;
        try {
          call = decodeHostCall(frame);
        } catch (error) {
          return protocolErrorFrame(error instanceof Error ? error.message : String(error));
        }
        const operation = operations[call.operation];
        if (!operation) return protocolErrorFrame(`Unsupported Cloudflare host operation: ${call.operation}`);
        if (call.args.length !== arities[call.operation]) {
          return protocolErrorFrame(`Invalid argument count for Cloudflare host operation: ${call.operation}`);
        }
        try {
          return await operation(call.args, call.bindingName);
        } catch (error) {
          return protocolErrorFrame(error instanceof Error ? error.message : String(error));
        }
      },
    },
    createEnvironmentBindings(env, types),
  );
  hostContexts.set(bindings.picorbWorkerHostCallBridge, {
    streams,
    create: () => createCloudflareBindings(env, types, { plugins }),
  });
  return bindings;
}

function decodeHostCallText(bytes) {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new HostProtocolError("Cloudflare host call text must be valid UTF-8");
  }
}

function protocolErrorFrame(message) {
  return encodeHostResult(HostResultKind.protocolError, utf8(message));
}

function normalizeBindingTypes(bindingTypes) {
  if (!bindingTypes || typeof bindingTypes !== "object" || Array.isArray(bindingTypes)) {
    throw new TypeError("Cloudflare binding types must be an object");
  }
  const normalized = Object.create(null);
  for (const [name, type] of Object.entries(bindingTypes)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("Cloudflare binding type contains an invalid name");
    }
    if (type !== "kv" && type !== "queue" && type !== "durable_object" &&
        type !== "d1" && type !== "r2" && type !== "ai" && type !== "vectorize") {
      throw new TypeError(`Unsupported Cloudflare binding type for ${name}: ${type}`);
    }
    normalized[name] = type;
  }
  return normalized;
}

function requireBindingType(bindingTypes, bindingName, expectedType) {
  const actualType = bindingTypes[bindingName];
  if (actualType === expectedType) return;
  if (actualType === undefined) {
    throw new HostBindingError(`Cloudflare binding ${bindingName} is not registered`);
  }
  throw new HostBindingError(`Cloudflare binding ${bindingName} is registered as ${actualType}, not ${expectedType}`);
}

class FrameWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  appendBytes(bytes) {
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  appendU32(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`Value cannot be encoded as u32: ${value}`);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.appendBytes(bytes);
  }

  appendString(value) {
    this.appendLengthPrefixedBytes(encoder.encode(value));
  }

  appendLengthPrefixedBytes(bytes) {
    this.appendU32(bytes.byteLength);
    this.appendBytes(bytes);
  }

  finish() {
    const frame = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      frame.set(part, offset);
      offset += part.byteLength;
    }
    return frame;
  }
}

class FrameReader {
  constructor(frame) {
    this.frame = frame;
    this.offset = 0;
  }

  readBytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.frame.byteLength) {
      throw new Error("Truncated PicoRuby Worker response frame");
    }
    const bytes = this.frame.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readU32() {
    const bytes = this.readBytes(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  readString() {
    return decoder.decode(this.readBytes(this.readU32()));
  }

  finish() {
    if (this.offset !== this.frame.byteLength) {
      throw new Error("PicoRuby Worker response frame has trailing bytes");
    }
  }
}

function copyToWasm(module, bytes) {
  const size = Math.max(bytes.byteLength, 1);
  const pointer = module._malloc(size);
  if (pointer === 0) {
    throw new Error("PicoRuby Wasm allocation failed");
  }
  module.HEAPU8.set(bytes, pointer);
  return pointer;
}

function readWasmString(module, pointer, length) {
  if (pointer === 0 || length === 0) return "";
  return decoder.decode(module.HEAPU8.subarray(pointer, pointer + length));
}

function readRuntimeError(module) {
  return readWasmString(
    module,
    module._picorb_worker_error_ptr(),
    module._picorb_worker_error_len(),
  );
}

async function readRequestBody(request, limit) {
  if (!request.body) return new Uint8Array();

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      throw new RequestBodyTooLargeError(limit);
    }
  }

  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("PicoRuby request body limit exceeded");
        throw new RequestBodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function encodeRackRequest(request, options = {}, streams) {
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const url = new URL(request.url);
  const scheme = url.protocol.slice(0, -1);
  const port = url.port || (scheme === "https" ? "443" : "80");
  const protocol = request.cf?.httpProtocol || "HTTP/1.1";
  const headers = Array.from(request.headers.entries());
  if (!streams) throw new Error("Host stream registry is unavailable");
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxRequestBodyBytes) {
    throw new RequestBodyTooLargeError(maxRequestBodyBytes);
  }
  const body = request.body || new ReadableStream({ start(controller) { controller.close(); } });
  const inputId = streams.registerInput(body, maxRequestBodyBytes);

  const writer = new FrameWriter();
  writer.appendBytes(REQUEST_MAGIC);
  writer.appendString(request.method);
  writer.appendString(scheme);
  writer.appendString(url.hostname);
  writer.appendString(port);
  writer.appendString(url.host);
  writer.appendString(url.pathname || "/");
  writer.appendString(url.search.length > 0 ? url.search.slice(1) : "");
  writer.appendString(protocol);
  writer.appendU32(headers.length);
  for (const [name, value] of headers) {
    writer.appendString(name);
    writer.appendString(value);
  }
  writer.appendU32(inputId);
  if (options.rackEnv !== undefined) {
    const rackEnv = options.rackEnv;
    if (!rackEnv || typeof rackEnv !== "object" || Array.isArray(rackEnv) ||
        Object.getPrototypeOf(rackEnv) !== Object.prototype ||
        Object.keys(rackEnv).some(key => key.length === 0)) {
      throw new TypeError("Rack env additions must be an object with non-empty keys");
    }
    validateJsonValue(rackEnv, "Rack env additions");
    const encoded = JSON.stringify(rackEnv);
    if (encoded === undefined || encoder.encode(encoded).byteLength > 65536) {
      throw new TypeError("Rack env additions must be JSON values within 64 KiB");
    }
    writer.appendString(encoded);
  }
  if (options.afterRequest !== undefined) {
    if (typeof options.afterRequest !== "function") {
      throw new TypeError("afterRequest must be a function");
    }
    if (options.rackEnv === undefined) writer.appendString("{}");
    writer.appendU32(1);
  }
  return writer.finish();
}

export function encodeQueueBatch(batch) {
  if (!batch || typeof batch !== "object" || typeof batch.queue !== "string" || batch.queue.length === 0 ||
      !Array.isArray(batch.messages) || batch.messages.length > 1024 ||
      typeof batch.ackAll !== "function" || typeof batch.retryAll !== "function") {
    throw new TypeError("Cloudflare Queue batch must have a name and at most 1024 messages");
  }
  const writer = new FrameWriter();
  writer.appendBytes(QUEUE_REQUEST_MAGIC);
  writer.appendString(batch.queue);
  writer.appendU32(batch.messages.length);
  for (const message of batch.messages) {
    if (!message || typeof message.id !== "string" || message.id.length === 0 || typeof message.body !== "string" ||
        !Number.isSafeInteger(message.attempts) || message.attempts < 1 || !(message.timestamp instanceof Date) ||
        !Number.isSafeInteger(message.timestamp.getTime()) || message.timestamp.getTime() < 0 ||
        typeof message.ack !== "function" || typeof message.retry !== "function") {
      throw new TypeError("Cloudflare Queue message must have a string ID and body, Date timestamp, and positive attempts");
    }
    if (encoder.encode(message.body).byteLength > MAX_QUEUE_MESSAGE_BYTES) {
      throw new RangeError(`Cloudflare Queue message exceeds ${MAX_QUEUE_MESSAGE_BYTES} bytes`);
    }
    writer.appendString(message.id);
    writer.appendString(String(message.timestamp.getTime()));
    writer.appendString(message.body);
    writer.appendU32(message.attempts);
  }
  if (writer.length > MAX_QUEUE_FRAME_BYTES) {
    throw new RangeError(`Cloudflare Queue batch exceeds ${MAX_QUEUE_FRAME_BYTES} bytes`);
  }
  return writer.finish();
}

export function decodeQueueResponse(frame, messageCount) {
  const reader = new FrameReader(frame);
  const magic = reader.readBytes(QUEUE_RESPONSE_MAGIC.byteLength);
  for (let index = 0; index < QUEUE_RESPONSE_MAGIC.byteLength; index += 1) {
    if (magic[index] !== QUEUE_RESPONSE_MAGIC[index]) {
      throw new Error("Unsupported PicoRuby Queue response frame");
    }
  }
  const batch = readQueueAction(reader);
  const count = reader.readU32();
  if (count !== messageCount) throw new Error("PicoRuby Queue response has an unexpected message count");
  const messages = [];
  for (let index = 0; index < count; index += 1) messages.push(readQueueAction(reader));
  const hasLog = reader.readU32();
  if (hasLog !== 0 && hasLog !== 1) throw new Error("PicoRuby Queue response has an invalid log flag");
  const log = hasLog === 0 ? null : readQueueLog(reader);
  reader.finish();
  return { batch, messages, log };
}

function readQueueAction(reader) {
  const kind = reader.readU32();
  const delaySeconds = reader.readU32();
  if (kind > 2 || (kind !== 2 && delaySeconds !== 0)) {
    throw new Error("PicoRuby Queue response has an invalid action");
  }
  return { kind, delaySeconds };
}

function applyQueueActions(batch, actions) {
  if (actions.batch.kind === 1) batch.ackAll();
  if (actions.batch.kind === 2) batch.retryAll(queueRetryOptions(actions.batch.delaySeconds));
  for (let index = 0; index < actions.messages.length; index += 1) {
    const action = actions.messages[index];
    const message = batch.messages[index];
    if (action.kind === 1) message.ack();
    if (action.kind === 2) message.retry(queueRetryOptions(action.delaySeconds));
  }
}

function queueRetryOptions(delaySeconds) {
  return delaySeconds === 0 ? undefined : { delaySeconds };
}

function readQueueLog(reader) {
  const level = reader.readString();
  const metadataJson = reader.readString();
  const message = reader.readString();
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new Error("PicoRuby Queue response has an invalid log level");
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    throw new Error("PicoRuby Queue response has invalid log metadata");
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("PicoRuby Queue response log metadata must be an object");
  }
  return { level, metadata, message };
}

function emitQueueLog(log) {
  if (log) console[log.level](log.message, log.metadata);
}

export function decodeRackResponse(frame, requestMethod = "GET", streams, signal, metadata) {
  const reader = new FrameReader(frame);
  const magic = reader.readBytes(RESPONSE_MAGIC.byteLength);
  for (let index = 0; index < RESPONSE_MAGIC.byteLength; index += 1) {
    if (magic[index] !== RESPONSE_MAGIC[index]) {
      throw new Error("Unsupported PicoRuby Worker response frame");
    }
  }

  const status = reader.readU32();
  const headerCount = reader.readU32();
  if (status < 200 || status > 599 || headerCount > 1024) {
    throw new Error("Invalid PicoRuby Worker response frame metadata");
  }

  const headers = new Headers();
  for (let index = 0; index < headerCount; index += 1) {
    headers.append(reader.readString(), reader.readString());
  }
  const mode = reader.readU32();
  if (mode !== 0 && mode !== 1) throw new Error("Unknown PicoRuby response body mode");
  const bodyData = mode === 0 ? reader.readBytes(reader.readU32()).slice() : reader.readU32();
  if (reader.offset < frame.byteLength) {
    const rackEnv = JSON.parse(reader.readString());
    if (!rackEnv || typeof rackEnv !== "object" || Array.isArray(rackEnv)) {
      throw new Error("Invalid PicoRuby Rack environment snapshot");
    }
    if (metadata) metadata.rackEnv = rackEnv;
  }
  reader.finish();

  const bodyAllowed = requestMethod !== "HEAD" && status !== 204 && status !== 205 && status !== 304;
  if (mode === 0) return new Response(bodyAllowed ? bodyData : null, { status, headers });
  if (!streams) throw new Error("Host stream registry is unavailable");
  // A streaming length is unknown, and transport framing belongs to Workers.
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const source = streams.take(bodyData);
  if (!bodyAllowed) {
    source.cancel("Response does not permit a body").catch(() => {});
    return new Response(null, { status, headers });
  }
  if (metadata && streams.isOutput(bodyData)) metadata.rubyOutput = true;
  const body = responseStream(source, signal);
  try {
    return new Response(body, { status, headers });
  } catch (error) {
    body.cancel(error).catch(() => {});
    throw error;
  }
}

export async function createRuntime(createPicoRuby, wasmModule, appBytecode, runtimeBindings = {}) {
  const bindings = mergeBindings(runtimeBindings);
  const context = hostContexts.get(bindings.picorbWorkerHostCallBridge);
  if (context) {
    bindings.picorbWorkerHostCallBridge = context.create().picorbWorkerHostCallBridge;
  }
  const streams = hostContexts.get(bindings.picorbWorkerHostCallBridge)?.streams ?? new HostStreamRegistry();
  if (!context) {
    const customHostBridge = bindings.picorbWorkerHostCallBridge;
    bindings.picorbWorkerHostCallBridge = async frame => {
      try {
        const call = decodeHostCall(frame);
        if ((call.operation === "input.read" || call.operation === "stream.read") &&
            call.bindingName === "" && call.args.length === 2) {
          return await captureHostCall(async () => {
            const streamId = Number(decodeHostCallText(call.args[0]));
            const length = Number(decodeHostCallText(call.args[1]));
            const bytes = call.operation === "input.read"
              ? await streams.readInput(streamId, length)
              : await streams.readStream(streamId, length);
            return bytes === null ? hostMissing() : hostOk(bytes);
          });
        }
        if (call.bindingName === "" && call.operation === "output.create" && call.args.length === 0) {
          return captureHostCall(() => streams.createOutput());
        }
        if (call.bindingName === "" && call.operation === "output.write" && call.args.length === 2) {
          return captureHostCall(async () => {
            await streams.writeOutput(Number(decodeHostCallText(call.args[0])), call.args[1]);
            return hostOk(new Uint8Array());
          });
        }
        if (call.bindingName === "" && call.operation === "output.close" && call.args.length === 1) {
          return captureHostCall(async () => {
            await streams.closeOutput(Number(decodeHostCallText(call.args[0])));
            return hostOk(new Uint8Array());
          });
        }
        if (customHostBridge) return await customHostBridge(frame);
        return protocolErrorFrame("Cloudflare host operation is unavailable");
      } catch (error) {
        return protocolErrorFrame(error instanceof Error ? error.message : String(error));
      }
    };
  }
  const module = await createPicoRuby({
    ...defaultRuntimeBindings,
    ...bindings,
    instantiateWasm(imports, successCallback) {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      successCallback(instance, wasmModule);
      return instance.exports;
    },
  });

  runtimeStreams.set(module, streams);
  const actualAbiVersion = module._picorb_worker_abi_version();
  if (actualAbiVersion !== ABI_VERSION) {
    throw new Error(`PicoRuby Worker ABI ${ABI_VERSION} is required (found ${actualAbiVersion})`);
  }

  const bytecode = new Uint8Array(appBytecode);
  const pointer = copyToWasm(module, bytecode);
  try {
    const status = await module.ccall(
      "picorb_worker_init",
      "number",
      ["number", "number"],
      [pointer, bytecode.byteLength],
      { async: true },
    );
    if (status !== 0) {
      throw new Error(`PicoRuby initialization failed: ${readRuntimeError(module)}`);
    }
  } catch (error) {
    streams?.discard();
    await closeRuntime(module);
    throw error;
  } finally {
    module._free(pointer);
  }
  return module;
}

export async function closeRuntime(module) {
  const streams = runtimeStreams.get(module);
  streams?.discardOutputs();
  const pendingDispatch = dispatchQueues.get(module);
  if (pendingDispatch) await pendingDispatch.catch(() => {});

  streams?.discardOutputs();
  const pump = runtimeOutputPumps.get(module);
  if (pump) await pump.catch(() => {});
  streams?.discard();
  await module.ccall(
    "picorb_worker_close",
    null,
    [],
    [],
    { async: true },
  );
}

export async function handleRequest(
  createPicoRuby,
  wasmModule,
  appBytecode,
  request,
  ...bindingSets
) {
  return handleRequestWithOptions(createPicoRuby, wasmModule, appBytecode, request, {}, ...bindingSets);
}

export async function handleRequestWithOptions(
  createPicoRuby,
  wasmModule,
  appBytecode,
  request,
  requestOptions,
  ...bindingSets
) {
  const bindings = mergeBindings(...bindingSets);
  const module = await createRuntime(createPicoRuby, wasmModule, appBytecode, bindings);
  try {
    const response = await dispatch(module, request, requestOptions);
    const pump = runtimeOutputPumps.get(module);
    if (pump) {
      const completion = pump.finally(() => closeRuntime(module));
      if (requestOptions.ctx?.waitUntil) requestOptions.ctx.waitUntil(completion);
      else completion.catch(error => console.error("Ruby output stream failed", error));
      return response;
    }
    await closeRuntime(module);
    return response;
  } catch (error) {
    await closeRuntime(module);
    throw error;
  }
}

export async function handleQueue(
  createPicoRuby,
  wasmModule,
  appBytecode,
  batch,
  ...bindingSets
) {
  const bindings = mergeBindings(...bindingSets);
  const module = await createRuntime(createPicoRuby, wasmModule, appBytecode, bindings);
  try {
    await dispatchQueue(module, batch);
  } finally {
    await closeRuntime(module);
  }
}

export function dispatch(module, request, requestOptions = {}) {
  const previousDispatch = dispatchQueues.get(module) ?? Promise.resolve();
  const currentDispatch = previousDispatch
    .catch(() => {})
    .then(async () => {
      const pump = runtimeOutputPumps.get(module);
      if (pump) await pump.catch(() => {});
      return dispatchOnce(module, request, requestOptions);
    });
  dispatchQueues.set(module, currentDispatch);

  return currentDispatch.finally(() => {
    if (dispatchQueues.get(module) === currentDispatch) {
      dispatchQueues.delete(module);
    }
  });
}

async function dispatchOnce(module, request, requestOptions) {
  const streams = runtimeStreams.get(module);
  const frame = await encodeRackRequest(request, requestOptions, streams);
  const pointer = copyToWasm(module, frame);
  try {
    const status = await module.ccall(
      "picorb_worker_dispatch_v1",
      "number",
      ["number", "number"],
      [pointer, frame.byteLength],
      { async: true },
    );
    const inputError = streams?.takeInputError();
    if (inputError) throw inputError;
    if (status !== 0) {
      throw new Error(`PicoRuby dispatch failed: ${readRuntimeError(module)}`);
    }

    const responsePointer = module._picorb_worker_response_ptr();
    const responseLength = module._picorb_worker_response_len();
    const responseFrame = module.HEAPU8.slice(responsePointer, responsePointer + responseLength);
    const metadata = {};
    const response = decodeRackResponse(responseFrame, request.method, runtimeStreams.get(module), request.signal, metadata);
    if (requestOptions.afterRequest === undefined) {
      if (metadata.rubyOutput) startRubyOutput(module);
      return response;
    }

    try {
      const replacement = await requestOptions.afterRequest(
        request, requestOptions.env, requestOptions.ctx, metadata.rackEnv, response,
      );
      if (replacement === undefined) {
        if (metadata.rubyOutput) startRubyOutput(module);
        return response;
      }
      if (!(replacement instanceof Response)) throw new TypeError("afterRequest must return a Response or undefined");
      if (replacement !== response) await discardResponseBody(response, "afterRequest replaced the response");
      else if (metadata.rubyOutput) startRubyOutput(module);
      return replacement;
    } catch (error) {
      await discardResponseBody(response, error);
      throw error;
    }
  } finally {
    runtimeStreams.get(module)?.discard();
    module._free(pointer);
  }
}

function startRubyOutput(module) {
  const pump = Promise.resolve().then(async () => {
    const status = await module.ccall("picorb_worker_stream_v1", "number", [], [], { async: true });
    if (status !== 0) throw new Error(`Ruby output stream failed: ${readRuntimeError(module)}`);
  });
  runtimeOutputPumps.set(module, pump);
  pump.finally(() => {
    if (runtimeOutputPumps.get(module) === pump) runtimeOutputPumps.delete(module);
  }).catch(() => {});
}

async function discardResponseBody(response, reason) {
  if (!response.body || response.body.locked) return;
  try {
    await response.body.cancel(reason);
  } catch {
    // Keep the hook result or original error when body cancellation fails.
  }
}

export async function dispatchQueue(module, batch) {
  const frame = encodeQueueBatch(batch);
  const pointer = copyToWasm(module, frame);
  try {
    const status = await module.ccall(
      "picorb_worker_queue_v1",
      "number",
      ["number", "number"],
      [pointer, frame.byteLength],
      { async: true },
    );
    if (status !== 0) {
      throw new Error(`PicoRuby Queue dispatch failed: ${readRuntimeError(module)}`);
    }
    const result = decodeQueueResponse(
      module.HEAPU8.slice(
        module._picorb_worker_response_ptr(),
        module._picorb_worker_response_ptr() + module._picorb_worker_response_len(),
      ),
      batch.messages.length,
    );
    applyQueueActions(batch, result);
    emitQueueLog(result.log);
  } finally {
    module._free(pointer);
  }
}
