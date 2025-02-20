// @ts-check
import * as crypto from "node:crypto";
import { inspect } from "node:util";
import { receiveMessageOnPort, MessageChannel } from "node:worker_threads";

let isClientWorker = false;
const clientWorkerLogs = [];

const CLIENT_LOGS_BUFFER = false;
const debug = process.env.DEBUG
  ? (...args) => {
      if (CLIENT_LOGS_BUFFER && isClientWorker) {
        clientWorkerLogs.push(args);
      } else {
        console.log(...args);
      }
    }
  : undefined;

if (CLIENT_LOGS_BUFFER) {
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection", reason);
    console.log(clientWorkerLogs);
  });
}

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
  /** @type {number} */ clientIndex,
  /** @type {string | undefined} */ source = undefined
) {
  const asArray = new Int32Array(buffer);
  debug?.("client :: calling Atomics.wait", source);
  const waitRes = Atomics.wait(asArray, clientIndex, ARR_VALUE_STATE.NOT_DONE);
  if (waitRes === "not-equal") {
    throw new Error(
      "Invariant: expected to be in NOT_DONE state when calling Atomics.wait"
    );
  }
  debug?.("client :: " + "=".repeat(80));
  debug?.("client :: Atomics.wait returned", waitRes, source);
}

function DANGEROUSLY_maybeWakeBlockedClient(
  /** @type {SharedArrayBuffer} */ buffer,
  /** @type {number} */ clientIndex
) {
  const asArray = new Int32Array(buffer);
  // Atomics.store(asArray, clientIndex, ARR_VALUE_STATE.DONE);
  const notifyRes = Atomics.notify(asArray, clientIndex);
  debug?.("server :: notified atomic", notifyRes);
  // Atomics.store(asArray, clientIndex, ARR_VALUE_STATE.NOT_DONE);
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

export function createClient(/** @type {ChannelClientHandle} */ handle) {
  isClientWorker = true;

  let poller;
  /** @type {ChannelClient} */
  const comm = {
    ...handle,
    batch: createBatch(),
    get poller() {
      if (!poller) {
        poller = createBatchPoller(comm);
      }
      return poller;
    },
  };

  return comm;
}

/** @returns {Batch} */
function createBatch() {
  return { items: [], start: promiseWithResolvers(), id: randomId() };
}

/**
 * @template T
 * @typedef {ReturnType<typeof promiseWithResolvers<T>>} PromiseWithResolvers<T>
 */

/**
 * @template TIn
 * @template TOut
 * @typedef {{ data: TIn, transfer: import("node:worker_threads").TransferListItem[], controller: PromiseWithResolvers<TOut> }} BatchItem<TIn, TOut>
 */

/** @typedef {{ id: number, items: BatchItem<unknown, any>[], start: PromiseWithResolvers<void> }} Batch */

/** @typedef {import("node:worker_threads").MessagePort} MessagePort */

/** @typedef {{ messagePort: MessagePort, buffer: SharedArrayBuffer, transferList: import("node:worker_threads").TransferListItem[]  }} ChannelEndBase */
/** @typedef {ChannelEndBase} ChannelServer */
/** @typedef {ChannelEndBase & { index: number } } ChannelClientHandle */
/** @typedef {ChannelClientHandle & { batch: Batch, poller: BatchPoller }} ChannelClient */

/** @typedef {InternalRequestPayload | InternalCreateClientPayload} InternalMessage */
/** @typedef {{ type: 'request', batchId: number, clientIndex: number, data: unknown[] }} InternalRequestPayload */
/** @typedef {{ batchId: number, index: number, data: Settled<unknown, ReturnType<typeof serializeThrown>> }} InternalResponsePayload */

/** @typedef {{ type: 'createClient', id: number, index: number, messagePort: MessagePort }} InternalCreateClientPayload */
/** @typedef {{ id: number, ok: boolean }} InternalCreateClientResultPayload */

/**
 * @template T, E
 * @typedef {{ status: 'fulfilled', value: T } | { status: 'rejected', reason: E }} Settled<T, E>
 * */

const POLLER_YIELD_ITERATIONS = 50; // arbitrary long-ish number (still much cheaper than serializing IO)
const BATCH_MICRO_WAIT_ITERATIONS = 100; // arbitrary long-ish number (still much cheaper than serializing IO)

function createBatchPoller(/** @type {ChannelClient} */ comm) {
  /** @type {Map<number, { batch: Batch, controller: PromiseWithResolvers<InternalResponsePayload> }>} */
  const waiters = new Map();

  function getBatchStatus(/** @type {Batch} */ batch) {
    if (batch.start.status === "fulfilled") {
      // batch started executing
      return getPendingBatchItemCount(batch.items) > 0 ? "running" : "done";
    } else {
      return "not-started";
    }
  }

  function getRunningBatchCount() {
    return [...waiters.values()].filter(
      (waiter) => getBatchStatus(waiter.batch) === "running"
    ).length;
  }

  /** @type {Promise<void> | undefined} */
  let readLoop;
  function isPolling() {
    return !!readLoop;
  }
  async function startPolling() {
    readLoop = startPollingImpl();
    try {
      await readLoop;
    } finally {
      readLoop = undefined;
    }
  }
  async function startPollingImpl() {
    while (true) {
      // TODO: this feels like an awkward place to put this
      if (!getRunningBatchCount()) {
        debug?.("client :: exiting read loop");
        readLoop = undefined;
        return;
      }

      const received = receiveMessageOnPort(comm.messagePort);
      debug?.(
        "client :: receiveMessageOnPort",
        received,
        received?.message?.batchId
      );
      if (!received) {
        // if possible, wait for a batch to start to maximize parallelism
        const wipBatch = comm.batch;
        if (wipBatch.items.length > 0) {
          debug?.(`client :: waiting for WIP batch to get submitted`);
          await wipBatch.start.promise;
          continue;
        } else {
          try {
            DANGEROUSLY_blockAndWaitForServer(
              comm.buffer,
              comm.index,
              `poller`
            );
            continue;
          } catch (err) {
            console.error("client :: error in poller", err);
            throw err;
          }
        }
      }

      /** @type {InternalResponsePayload} */
      const message = received.message;
      const waiter = waiters.get(message.batchId);
      if (!waiter) {
        // TODO: queue?
        throw new Error(
          `Invariant :: poller got message for batch that is not waiting (${message.batchId})`
        );
      }
      debug?.("client :: yielding to batch", waiter.batch.id);
      waiter.controller.resolve(message);
      waiters.delete(message.batchId);

      // yield and let other code run.
      for (let i = 0; i < POLLER_YIELD_ITERATIONS; i++) {
        await null;
      }
    }
  }

  return {
    waitForMessage(/** @type {Batch} */ batch) {
      /** @type {PromiseWithResolvers<InternalResponsePayload>} */
      const controller = promiseWithResolvers();
      waiters.set(batch.id, { batch, controller });
      if (!isPolling()) {
        void startPolling();
      }
      return controller.promise;
    },
  };
}

/** @typedef {ReturnType<typeof createBatchPoller>} BatchPoller */

export function sendRequest(
  /** @type {ChannelClient} */ comm,
  /** @type {any} */ data,
  /** @type {import("node:worker_threads").TransferListItem[]} */ transfer = []
) {
  const resultController = promiseWithResolvers();

  const batch = comm.batch;
  const isFirstItem = batch.items.length === 0;
  batch.items.push({ data, transfer, controller: resultController });
  debug?.(
    "client :: sendRequest",
    data,
    `(current batch: ${batch.items.length} items)`
  );

  const batchStartPromise = raceBatchStart(batch);

  // we want this to only get kicked off once, so only do it for the first item.
  if (isFirstItem) {
    void batchStartPromise.then(async () => {
      comm.batch = createBatch();
      try {
        await executeBatch(comm, batch);
      } catch (err) {
        // something very bad happened. reject the whole batch
        rejectBatchItems(batch.items, err);
      }
    });
  }

  return resultController.promise;
}

async function executeBatch(
  /** @type {ChannelClient} */ comm,
  /** @type {Batch} */ batch
) {
  let requestedBatchItems = batch.items;
  const rejectBatch = (/** @type {unknown} */ err) => {
    rejectBatchItems(requestedBatchItems, err);
  };

  /** @type {(() => void)[]} */
  const cleanups = [];
  const runCleanups = () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.length = 0;
  };

  // schedule cleanups to run when all promises from the batch are settled
  void Promise.allSettled(
    batch.items.map((item) => item.controller.promise)
  ).then(() => {
    debug?.("client :: batch settled, running cleanups");
    runCleanups();
  });

  let timeoutRan = false;
  const timeout = setTimeout(() => {
    timeoutRan = true;
  });
  cleanups.push(() => clearTimeout(timeout));
  const didFinishWithinATask = () => {
    return !timeoutRan;
  };

  try {
    sendBatchItems(comm, batch.id, requestedBatchItems);
  } catch (err) {
    if (isDataCloneError(err)) {
      // Some batch items contain uncloneable values.
      // Find which items couldn't be sent, reject their promises, remove them from the batch,
      // then try sending it again.
      debug?.("client :: unclonable items in batch");
      const fallbackBatchItems =
        rejectAndRemoveUncloneableBatchItems(requestedBatchItems);
      if (fallbackBatchItems.length === 0) {
        // we already errored all the requests above, nothing left to send.
        return;
      }
      requestedBatchItems = fallbackBatchItems;
      try {
        sendBatchItems(comm, batch.id, requestedBatchItems);
      } catch (err) {
        // We can't do anything other than error the whole batch.
        return rejectBatch(err);
      }
    } else {
      return rejectBatch(err);
    }
  }

  while (true) {
    const message = await comm.poller.waitForMessage(batch);
    handleResponse(message);

    const pendingCount = getPendingBatchItemCount(requestedBatchItems);
    if (pendingCount === 0) {
      break;
    }
  }

  function handleResponse(/** @type {InternalResponsePayload} */ message) {
    debug?.("client :: handleResponse", message);
    if (message.batchId !== batch.id) {
      debug?.(
        `client :: handleResponse[${batch.id}]: got message for different batch (${message.batchId})`
      );
      return;
    }
    const { index: batchItemIndex, data: batchItemResult } = message;

    if (!didFinishWithinATask()) {
      return rejectBatch(
        new Error(
          "Invariant: Did not receive a response message in under a task"
        )
      );
    }

    if (batchItemResult.status === "fulfilled") {
      requestedBatchItems[batchItemIndex].controller.resolve(
        batchItemResult.value
      );
    } else {
      requestedBatchItems[batchItemIndex].controller.reject(
        deserializeThrown(batchItemResult.reason)
      );
    }
  }
}

function getPendingBatchItemCount(/** @type {Batch['items']} */ batchItems) {
  return batchItems.filter((item) => item.controller.status === "pending")
    .length;
}

function sendBatchItems(
  /** @type {ChannelClient} */ comm,
  /** @type {number} */ batchId,
  /** @type {Batch['items']} */ batchItems
) {
  /** @type {InternalRequestPayload} */
  const requestPayload = {
    type: "request",
    batchId,
    clientIndex: comm.index,
    data: batchItems.map((item) => item.data),
  };
  const requestTransferList = batchItems.flatMap((item) => item.transfer);
  debug?.("client :: sending batch", requestPayload, requestTransferList);
  comm.messagePort.postMessage(requestPayload, requestTransferList);
}


function rejectBatchItems(
  /** @type {Batch['items']} */ batchItems,
  /** @type {unknown} */ err
) {
  debug?.("client :: rejecting batch", err);
  for (let i = 0; i < batchItems.length; i++) {
    batchItems[i].controller.reject(
      new Error("Failed to execute batch", { cause: err })
    );
  }
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
    }
    cloneable.push(item);
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
  }
  // if we got here, we waited for `BATCH_MICRO_WAIT_ITERATIONS` and we're still the last item,
  // so we consider the batch closed and can kick off the request.
  batch.start.resolve();
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
    const { batchId, clientIndex, data: requests } = message;
    debug?.(`server :: request from ${clientIndex}`, requests);

    /** @returns {Promise<Settled<unknown, ReturnType<typeof serializeThrown>>>} */
    async function runRequest(request) {
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
    }

    requests.forEach(async (request, index) => {
      const result = await runRequest(request);
      /** @type {InternalResponsePayload} */
      const responsePayload = {
        batchId,
        index,
        data: result,
      };

      debug?.(`server :: sending response (${batchId}[${index}])`, result);
      try {
        sourcePort.postMessage(responsePayload);
      } catch (err) {
        if (isDataCloneError(err)) {
          // We tried to respond with something uncloneable.
          // find out which results caused this and error them.
          /** @type {InternalResponsePayload} */
          const fallbackResponsePayload = {
            batchId,
            index,
            data: replaceUncloneableResultWithError(result),
          };
          sourcePort.postMessage(fallbackResponsePayload);
        } else {
          // nothing more we can do here
          throw err;
        }
      }

      try {
        DANGEROUSLY_maybeWakeBlockedClient(comm.buffer, clientIndex);
      } catch (err) {
        throw new Error(`Error while waking client for ${batchId}[${index}]`, {
          cause: err,
        });
      }
    });
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
function replaceUncloneableResultWithError(
  /** @type {InternalResponsePayload['data']} */ result
) {
  try {
    structuredClone(
      result.status === "fulfilled" ? result.value : result.reason
    );
  } catch (err) {
    return { status: "rejected", reason: serializeThrown(err) };
  }
  return result;
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

  /** @type {'pending' | 'fulfilled' | 'rejected'} */
  let status = "pending";

  /** @type {Promise<T>} */
  const promise = new Promise((_resolve, _reject) => {
    resolve = (value) => {
      if (status === "pending") {
        status = "fulfilled";
      }
      _resolve(value);
    };
    reject = (value) => {
      if (status === "pending") {
        status = "rejected";
      }
      _reject(value);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get status() {
      return status;
    },
  };
}

function randomId() {
  return crypto.randomInt(0, Math.pow(2, 48) - 1);
}
