// @ts-check
import * as crypto from "node:crypto";
import { receiveMessageOnPort, MessageChannel } from "node:worker_threads";

const debug = process.env.DEBUG ? console.log : undefined;

//===============================================
// atomics-based primitives that let us block
//===============================================

const ARR_VALUE_STATE = {
  NO_CLIENT: 0,
  NOT_DONE: 1,
  DONE: 2,
};

function createStateBuffer(/** @type {number} */ maxClients) {
  const buffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * maxClients
  );
  // NOTE: we don't have to initialize the buffer, because NO_CLIENT is 0
  return buffer;
}

function getMaxNumClients(/** @type {SharedArrayBuffer} */ buffer) {
  return buffer.byteLength / Int32Array.BYTES_PER_ELEMENT;
}

function initializeClientState(/** @type {SharedArrayBuffer} */ buffer) {
  const asArray = new Int32Array(buffer);
  const maxClients = asArray.length;

  if (maxClients === 0) {
    throw new Error("Cannot create client, because maxClients is 0");
  }

  const index = asArray.indexOf(ARR_VALUE_STATE.NO_CLIENT);
  if (index === -1) {
    throw new Error(`Cannot create more than ${maxClients} clients`);
  }
  asArray[index] = ARR_VALUE_STATE.NOT_DONE;
  return index;
}

function DANGEROUSLY_blockAndWaitForServer(
  /** @type {SharedArrayBuffer} */ buffer,
  /** @type {number} */ clientIndex
) {
  const asArray = new Int32Array(buffer);
  debug?.("client :: calling Atomics.wait");
  const waitRes = Atomics.wait(asArray, clientIndex, ARR_VALUE_STATE.NOT_DONE);
  if (waitRes === "not-equal") {
    throw new Error(
      "Invariant: expected to be in NOT_DONE state when calling Atomics.wait"
    );
  }
  debug?.("client :: Atomics.wait returned", waitRes);
}

function DANGEROUSLY_wakeBlockedClient(
  /** @type {SharedArrayBuffer} */ buffer,
  /** @type {number} */ clientIndex
) {
  const asArray = new Int32Array(buffer);
  Atomics.store(asArray, clientIndex, ARR_VALUE_STATE.DONE);
  const notifyRes = Atomics.notify(asArray, clientIndex);
  if (notifyRes < 1) {
    throw new Error(
      "Invariant: expected Atomics.notify to wake at least one listener"
    );
  }
  debug?.("server :: notified atomic", notifyRes);
  Atomics.store(asArray, clientIndex, ARR_VALUE_STATE.NOT_DONE);
}

//===============================================
// top-level API
//===============================================

export function createChannel(/** @type {number} */ maxClients = 1) {
  const buffer = createStateBuffer(maxClients);

  const serverChannel = new MessageChannel();
  /** @type {ChannelServer} */
  const serverHandle = {
    messagePort: serverChannel.port2,
    buffer,
    transferList: [serverChannel.port2],
  };

  return {
    serverMessagePort: serverChannel.port1,
    serverHandle,
  };
}

//===============================================
// client - will be blocked
//===============================================

/** @returns {Promise<ChannelClientHandle>} */
export async function createClientHandle(
  /** @type {ReturnType<createChannel>} */ channel
) {
  const buffer = channel.serverHandle.buffer;
  const index = initializeClientState(buffer);
  const maxClients = getMaxNumClients(buffer);

  /** @type {MessagePort} */
  let clientPort;

  if (maxClients === 1) {
    // there can only ever be one client, so we can use the default port
    // without doing the whole `createClient` message dance
    clientPort = channel.serverMessagePort;
  } else {
    // we need separate ports for each client because each MessagePort can only be transferred once
    const clientChannel = new MessageChannel();
    clientPort = clientChannel.port1;

    await new Promise((resolve, reject) => {
      // TODO: prevent deadlocks here (if no server exists yet and this is awaited, we might never get a reply)
      channel.serverMessagePort.addEventListener(
        "message",
        function handle(rawEvent) {
          const event = /** @type {MessageEvent} */ (rawEvent);
          const message = event.data;
          if (message.id !== requestPayload.id) {
            return;
          }
          channel.serverMessagePort.removeEventListener("message", handle);
          /** @type {InternalCreateClientResultPayload} */
          const { ok } = message;
          if (!ok) {
            return reject(
              new Error("Failed to register new client with server")
            );
          }
          return resolve(undefined);
        }
      );

      /** @type {InternalCreateClientPayload} */
      const requestPayload = {
        type: "createClient",
        id: randomId(),
        index,
        messagePort: clientChannel.port2,
      };
      debug?.("client :: sending createClient message", requestPayload);
      channel.serverMessagePort.postMessage(requestPayload, [
        requestPayload.messagePort,
      ]);
    });
  }

  return {
    messagePort: clientPort,
    buffer,
    index,
    transferList: [clientPort],
  };
}

/** @returns {ChannelClient} */
export function createClient(/** @type {ChannelClientHandle} */ handle) {
  return {
    ...handle,
    batch: createBatch(),
  };
}

/** @returns {Batch} */
function createBatch() {
  return { items: [], start: promiseWithResolvers() };
}

/**
 * @template T
 * @typedef {ReturnType<typeof promiseWithResolvers<T>>} PromiseWithResolvers<T>
 */

/**
 * @template TIn
 * @template TOut
 * @typedef {{ data: TIn, transfer: import("node:worker_threads").TransferListItem[], controller: Omit<PromiseWithResolvers<TOut>, 'promise'> }} BatchItem<TIn, TOut>
 */

/** @typedef {{ items: BatchItem<unknown, any>[], start: PromiseWithResolvers<void> }} Batch */

/** @typedef {import("node:worker_threads").MessagePort} MessagePort */

/** @typedef {{ messagePort: MessagePort, buffer: SharedArrayBuffer, transferList: import("node:worker_threads").TransferListItem[]  }} ChannelEndBase */
/** @typedef {ChannelEndBase} ChannelServer */
/** @typedef {ChannelEndBase & { index: number } } ChannelClientHandle */
/** @typedef {ChannelClientHandle & { batch: Batch }} ChannelClient */

/** @typedef {InternalRequestPayload | InternalCreateClientPayload} InternalMessage */
/** @typedef {{ type: 'request', id: number, clientIndex: number, data: unknown[] }} InternalRequestPayload */
/** @typedef {{ id: number, data: Settled<unknown, ReturnType<typeof serializeThrown>>[] }} InternalResponsePayload */

/** @typedef {{ type: 'createClient', id: number, index: number, messagePort: MessagePort }} InternalCreateClientPayload */
/** @typedef {{ id: number, ok: boolean }} InternalCreateClientResultPayload */

/**
 * @template T, E
 * @typedef {{ status: 'fulfilled', value: T } | { status: 'rejected', reason: E }} Settled<T, E>
 * */

const USE_SYNC_MESSAGE_RECEIVE = true;
const BATCH_MICRO_WAIT_ITERATIONS = 100; // arbitrary long-ish number (still much cheaper than serializing IO)

export function sendRequest(
  /** @type {ChannelClient} */ comm,
  /** @type {any} */ data,
  /** @type {import("node:worker_threads").TransferListItem[]} */ transfer = []
) {
  // if a batch is ongoing, item 0 will handle sending it and resolving the promise,
  // we just need to register ourselves and bump the start timer.
  if (comm.batch.items.length > 0) {
    const controller = promiseWithResolvers();
    comm.batch.items.push({
      data,
      transfer,
      controller,
    });
    void raceBatchStart(comm.batch);
    return controller.promise;
  }

  return new Promise(async (resolve, reject) => {
    const id = randomId();

    let timeoutRan = false;
    const timeout = setTimeout(() => {
      timeoutRan = true;
    });
    const didFinishWithinATask = () => {
      if (!timeoutRan) {
        clearTimeout(timeout);
      }
      return !timeoutRan;
    };

    function handleResponse(/** @type {Event} */ rawEvent) {
      const event = /** @type {MessageEvent} */ (rawEvent);
      /** @type {InternalResponsePayload} */
      const { id: incomingId, data: batchResponse } = event.data;
      if (incomingId !== id) {
        return;
      }

      if (!Array.isArray(batchResponse)) {
        return rejectBatch(new Error("Invariant: Response is not an array"));
      }
      if (batchResponse.length !== requestedBatchItems.length) {
        return rejectBatch(
          new Error(
            `Invariant: Expected response to have length ${requestedBatchItems.length}, got ${batchResponse.length}`
          )
        );
      }

      if (!USE_SYNC_MESSAGE_RECEIVE) {
        comm.messagePort.removeEventListener("message", handleResponse);
      }

      if (!didFinishWithinATask()) {
        return rejectBatch(
          new Error(
            "Invariant: Did not receive a response message in under a task"
          )
        );
      }

      for (let i = 0; i < requestedBatchItems.length; i++) {
        const result = batchResponse[i];
        if (result.status === "fulfilled") {
          requestedBatchItems[i].controller.resolve(result.value);
        } else {
          requestedBatchItems[i].controller.reject(
            deserializeThrown(result.reason)
          );
        }
      }
    }

    if (!USE_SYNC_MESSAGE_RECEIVE) {
      comm.messagePort.addEventListener("message", handleResponse);
    }

    comm.batch.items.push({ data, transfer, controller: { resolve, reject } });
    await raceBatchStart(comm.batch);

    // we're item 0, so we send the batch
    let requestedBatchItems = comm.batch.items;
    comm.batch = createBatch();

    const rejectBatch = (/** @type {Error} */ err) => {
      debug?.("client :: rejecting batch", err);
      for (let i = 0; i < requestedBatchItems.length; i++) {
        requestedBatchItems[i].controller.reject(
          new Error("Failed to execute batch", { cause: err })
        );
      }
    };

    try {
      sendBatchItems(comm, id, requestedBatchItems);
    } catch (err) {
      if (isDataCloneError(err)) {
        // Some batch items contain uncloneable values.
        // Find which items couldn't be sent, reject their promises, remove them from the batch,
        // then try sending it again.
        const fallbackBatchItems =
          rejectAndRemoveUncloneableBatchItems(requestedBatchItems);
        if (fallbackBatchItems.length === 0) {
          // we already errored all the requests above, nothing left to send.
          return;
        }
        requestedBatchItems = fallbackBatchItems;
        try {
          sendBatchItems(comm, id, requestedBatchItems);
        } catch (err) {
          // We can't do anything other than error the whole batch.
          return rejectBatch(err);
        }
      }
      return rejectBatch(err);
    }

    // block event loop while we wait
    try {
      DANGEROUSLY_blockAndWaitForServer(comm.buffer, comm.index);
    } catch (err) {
      return rejectBatch(err);
    }

    if (USE_SYNC_MESSAGE_RECEIVE) {
      const msg = receiveMessageOnPort(comm.messagePort);
      if (!msg) {
        return rejectBatch(
          new Error("Expected a response message to be available synchronously")
        );
      }
      return handleResponse(
        /** @type {MessageEvent} */ ({ data: msg.message })
      );
    }
  });
}

function sendBatchItems(
  /** @type {ChannelClient} */ comm,
  /** @type {number} */ messageId,
  /** @type {Batch['items']} */ batchItems
) {
  /** @type {InternalRequestPayload} */
  const requestPayload = {
    type: "request",
    id: messageId,
    clientIndex: comm.index,
    data: batchItems.map((item) => item.data),
  };
  const requestTransferList = batchItems.flatMap((item) => item.transfer);
  debug?.("client :: sending batch", requestPayload, requestTransferList);
  comm.messagePort.postMessage(requestPayload, requestTransferList);
}

/** @returns {Batch['items']} */
function rejectAndRemoveUncloneableBatchItems(
  /** @type {Batch['items']} */ batchItems
) {
  /** @type {Batch['items']} */
  const cloneable = [];
  for (let i = 0; i < batchItems.length; i++) {
    const item = batchItems[i];
    try {
      // Despite having `item.transfer` here, we can't pass it to `structuredClone` to test
      // if the error was caused by a incomplete transferList, because then we wouldn't be able to use it again
      // to actually send the message.
      structuredClone(item.data);
    } catch (err) {
      // Error the items whose arguments could not be cloned, and remove it from the items to be sent.
      //
      // Note that this error could also be a `ERR_MISSING_TRANSFERABLE_IN_TRANSFER_LIST`
      // (because we can't pass `item.transfer` above),
      // so we have to check if it's specifically data-cloning.
      // if not, it'll be thrown again when we retry sending.
      if (isDataCloneError(err)) {
        batchItems[i].controller.reject(err);
        continue;
      }
      cloneable.push(item);
    }
  }
  return cloneable;
}

function raceBatchStart(/** @type {Batch} */ batch) {
  void raceBatchStartImpl(batch);
  return batch.start.promise;
}

async function raceBatchStartImpl(/** @type {Batch} */ batch) {
  // I don't know if there's a way to wait until all pending microtasks are done without leaving the current task.
  // But what we can do is wait for a while, let other microtasks appear/execute, and then close the batch after a period of time.
  const initialBatchLength = batch.items.length;
  for (let i = 0; i < BATCH_MICRO_WAIT_ITERATIONS; i++) {
    await null;
    if (batch.items.length !== initialBatchLength) {
      // the batch length changed, so we're no longer the last item --
      // the new last item is responsible for resolving the start promise,
      // and has its own `raceBatchStart` going, so we've got nothing to do here.
      // (and it's pointless for us to create more microtasks here)
      return;
    }

    // if we got here, we waited for `BATCH_MICRO_WAIT_ITERATIONS` and we're still the last item,
    // so we consider the batch closed and can kick off the request.
    batch.start.resolve();
  }
}

//===============================================
// server - will do work while client is blocked
//===============================================

export function listenForRequests(
  /** @type {ChannelServer} */ comm,
  /** @type {(data: any) => Promise<any>} */ handler
) {
  /** @type {(() => void)[]} */
  const cleanups = [];

  async function handleEvent(/** @type {Event} */ rawEvent) {
    const event = /** @type {MessageEvent} */ (rawEvent);
    /** @type {MessagePort} */
    const sourcePort = this;

    /** @type {InternalMessage} */
    const message = event.data;
    if (message.type === "createClient") {
      return handleCreateClient(sourcePort, message);
    } else if (message.type === "request") {
      return handleRequest(sourcePort, message);
    } else {
      console.error("server :: Received unrecognized message", message);
    }
  }

  // TODO: destroy
  async function handleCreateClient(
    /** @type {MessagePort} */ sourcePort,
    /** @type {InternalCreateClientPayload} */ message
  ) {
    const { id, messagePort } = message;

    // TODO: technically, we shouldn't receive control messages on this port,
    // but this is maybe fine...?
    messagePort.addEventListener("message", handleEvent);
    cleanups.push(() =>
      messagePort.removeEventListener("message", handleEvent)
    );

    /** @type {InternalCreateClientResultPayload} */
    const responsePayload = { id, ok: true };
    sourcePort.postMessage(responsePayload);
  }

  async function handleRequest(
    /** @type {MessagePort} */ sourcePort,
    /** @type {InternalRequestPayload} */ message
  ) {
    // request
    const { id, clientIndex, data: requests } = message;
    debug?.(`server :: request from ${clientIndex}`, requests);

    /** @type {InternalResponsePayload['data']} */
    const results = await Promise.all(
      requests.map(async (request) => {
        // make sure the `any` on the response type doesn't make us bypass type safety
        const handlerSafe = /** @type {(arg: unknown) => Promise<unknown>} */ (
          handler
        );
        try {
          return { status: "fulfilled", value: await handlerSafe(request) };
        } catch (error) {
          // TODO: might need to serialize the error somehow here
          return { status: "rejected", reason: serializeThrown(error) };
        }
      })
    );

    debug?.("server :: sending response:", results);
    /** @type {InternalResponsePayload} */
    const responsePayload = { id, data: results };
    try {
      sourcePort.postMessage(responsePayload);
    } catch (err) {
      if (isDataCloneError(err)) {
        // We tried to respond with something uncloneable.
        // find out which results caused this and error them.
        /** @type {InternalResponsePayload} */
        const fallbackResponsePayload = {
          id,
          data: replaceUncloneableResultsWithError(results),
        };
        sourcePort.postMessage(fallbackResponsePayload);
      } else {
        // nothing more we can do here
        throw err;
      }
    }

    DANGEROUSLY_wakeBlockedClient(comm.buffer, clientIndex);
  }

  comm.messagePort.addEventListener("message", handleEvent);
  cleanups.push(() =>
    comm.messagePort.removeEventListener("message", handleEvent)
  );
  debug?.("server :: listening");

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

/** @returns {InternalResponsePayload['data']} */
function replaceUncloneableResultsWithError(
  /** @type {InternalResponsePayload['data']} */ results
) {
  return results.map((result) => {
    try {
      structuredClone(
        result.status === "fulfilled" ? result.value : result.reason
      );
    } catch (err) {
      return { status: "rejected", reason: serializeThrown(err) };
    }
    return result;
  });
}

//===============================================
// misc
//===============================================

/** @returns {err is DOMException} */
function isDataCloneError(/** @type {unknown} */ err) {
  return !!(
    err &&
    typeof err === "object" &&
    err instanceof DOMException &&
    err.name === "DataCloneError"
  );
}

function serializeThrown(/** @type {unknown} */ error) {
  if (error && typeof error === "object" && error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      // TODO: cause
    };
  }
  // this is an edge case, we don't really care, just make it a string
  return `${error}`;
}

function deserializeThrown(
  /** @type {ReturnType<typeof serializeThrown>} */ serialized
) {
  if (typeof serialized === "object") {
    const error = new Error(serialized.message);
    error.name = serialized.name;
    if (serialized.stack) {
      error.stack = serialized.stack;
    }
    return error;
  }
  return serialized;
}

/** @template T */
function promiseWithResolvers() {
  /** @type {(value: T) => void} */
  let resolve = /** @type {any} */ (undefined);
  /** @type {(error: unknown) => void} */
  let reject = /** @type {any} */ (undefined);

  /** @type {Promise<T>} */
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

function randomId() {
  return crypto.randomInt(0, Math.pow(2, 48) - 1);
}
