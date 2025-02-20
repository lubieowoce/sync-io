import * as crypto from "node:crypto";
import {
  receiveMessageOnPort,
  MessageChannel,
  type TransferListItem,
  type MessagePort,
} from "node:worker_threads";

let isClientWorker = false;
const clientWorkerLogs: any[][] = [];

const CLIENT_LOGS_BUFFER = false;
const debug = process.env.DEBUG
  ? (...args: any[]) => {
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

function createStateBuffer(maxClients: number) {
  const buffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * maxClients
  );
  // NOTE: we don't have to initialize the buffer, because NO_CLIENT is 0
  return buffer;
}

function getMaxNumClients(buffer: SharedArrayBuffer) {
  return buffer.byteLength / Int32Array.BYTES_PER_ELEMENT;
}

function initializeClientState(buffer: SharedArrayBuffer) {
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
  buffer: SharedArrayBuffer,
  clientIndex: number,
  source: string | undefined = undefined
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
  buffer: SharedArrayBuffer,
  clientIndex: number
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

export function createChannel(maxClients: number = 1) {
  const buffer = createStateBuffer(maxClients);

  const serverChannel = new MessageChannel();
  const serverHandle: ChannelServer = {
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

export async function createClientHandle(
  channel: ReturnType<typeof createChannel>
): Promise<ChannelClientHandle> {
  const buffer = channel.serverHandle.buffer;
  const index = initializeClientState(buffer);
  const maxClients = getMaxNumClients(buffer);

  let clientPort: MessagePort;

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
        function handle(rawEvent: Event) {
          const event = rawEvent as MessageEvent;
          const message = event.data;
          if (message.id !== requestPayload.id) {
            return;
          }
          channel.serverMessagePort.removeEventListener("message", handle);
          const { ok } = message as InternalCreateClientResultPayload;
          if (!ok) {
            return reject(
              new Error("Failed to register new client with server")
            );
          }
          return resolve(undefined);
        }
      );

      const requestPayload: InternalCreateClientPayload = {
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

export function createClient(handle: ChannelClientHandle): ChannelClient {
  isClientWorker = true;

  return {
    ...handle,
    batch: createBatch(),
    pollerState: createPollerState(),
  };
}

function createBatch(): Batch {
  return { items: [], start: promiseWithResolvers(), id: randomId() };
}

type PromiseWithResolvers<T> = ReturnType<typeof promiseWithResolvers<T>>;

type BatchItem<TIn, TOut> = {
  id: number;
  data: TIn;
  transfer: TransferListItem[];
  controller: PromiseWithResolvers<TOut>;
};

type Batch = {
  id: number;
  items: BatchItem<unknown, any>[];
  start: PromiseWithResolvers<void>;
};

type ChannelEndBase = {
  messagePort: MessagePort;
  buffer: SharedArrayBuffer;
  transferList: TransferListItem[];
};
export type ChannelServer = ChannelEndBase;
export type ChannelClientHandle = ChannelEndBase & { index: number };
export type ChannelClient = ChannelClientHandle & {
  batch: Batch;
  pollerState: PollerState;
};

type InternalMessage = InternalRequestPayload | InternalCreateClientPayload;
type InternalRequestPayload = {
  type: "request";
  clientIndex: number;
  items: { id: number; data: unknown }[];
};
type InternalResponsePayload = {
  id: number;
  data: Settled<unknown, ReturnType<typeof serializeThrown>>;
};

type InternalCreateClientPayload = {
  type: "createClient";
  id: number;
  index: number;
  messagePort: MessagePort;
};
type InternalCreateClientResultPayload = { id: number; ok: boolean };

type PollerTask<T> = { id: number; controller: PromiseWithResolvers<T> };

type Settled<T, E> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: E };

const POLLER_YIELD_ITERATIONS = 50; // arbitrary long-ish number (still much cheaper than serializing IO)
const BATCH_MICRO_WAIT_ITERATIONS = 100; // arbitrary long-ish number (still much cheaper than serializing IO)

export function sendRequest(
  client: ChannelClient,
  data: any,
  transfer: TransferListItem[] = []
) {
  let timeoutRan = false;
  const timeout = setTimeout(() => {
    timeoutRan = true;
  });

  const resultController = promiseWithResolvers();

  const batch = client.batch;
  const isFirstItem = batch.items.length === 0;
  batch.items.push({
    id: randomId(),
    data,
    transfer,
    controller: resultController,
  });
  debug?.(
    "client :: sendRequest",
    data,
    `(current batch: ${batch.items.length} items)`
  );

  const batchStartPromise = raceBatchStart(batch);

  // we want this to only get kicked off once, so only do it for the first item.
  if (isFirstItem) {
    void batchStartPromise.then(async () => {
      client.batch = createBatch();
      try {
        executeBatch(client, batch);
      } catch (err) {
        // something very bad happened. reject the whole batch
        rejectBatchItems(
          batch.items,
          new Error("Internal error: executeBatch crashed", { cause: err })
        );
      }
    });
  }

  try {
    return resultController.promise;
  } finally {
    if (timeoutRan) {
      throw new Error("Invariant: Did not settle request in under a task");
    } else {
      clearTimeout(timeout);
    }
  }
}

function executeBatch(client: ChannelClient, batch: Batch) {
  let batchItemsToRequest = batch.items;

  const rejectBatch = (err: unknown) => {
    rejectBatchItems(batchItemsToRequest, err);
  };

  try {
    sendBatchItems(client, batchItemsToRequest);
  } catch (err) {
    if (isDataCloneError(err)) {
      // Some batch items contain uncloneable values.
      // Find which items couldn't be sent, reject their promises, remove them from the batch,
      // then try sending it again.
      debug?.("client :: unclonable items in batch");
      const fallbackBatchItems =
        rejectAndRemoveUncloneableBatchItems(batchItemsToRequest);
      if (fallbackBatchItems.length === 0) {
        // we already errored all the requests above, nothing left to send.
        return;
      }
      batchItemsToRequest = fallbackBatchItems;
      try {
        sendBatchItems(client, batchItemsToRequest);
      } catch (err) {
        // We can't do anything other than error the whole batch.
        return rejectBatch(err);
      }
    } else {
      return rejectBatch(err);
    }
  }
  const requestedBatchItems = batchItemsToRequest;

  for (const batchItem of requestedBatchItems) {
    addTaskToPoller(client, batchItem);
  }
  startPolling(client);
}

function sendBatchItems(client: ChannelClient, batchItems: Batch["items"]) {
  const requestPayload: InternalRequestPayload = {
    type: "request",
    clientIndex: client.index,
    items: batchItems.map((item) => ({ id: item.id, data: item.data })),
  };
  const requestTransferList = batchItems.flatMap((item) => item.transfer);
  debug?.("client :: sending batch", requestPayload, requestTransferList);
  client.messagePort.postMessage(requestPayload, requestTransferList);
}

function rejectBatchItems(batchItems: Batch["items"], err: unknown) {
  debug?.("client :: rejecting batch", err);

  if (batchItems.length === 1) {
    // if there's only one task, we can error it directly.
    if (batchItems[0].controller.status === "pending") {
      batchItems[0].controller.reject(err);
    }
    return;
  }

  for (let i = 0; i < batchItems.length; i++) {
    if (batchItems[i].controller.status === "pending") {
      batchItems[i].controller.reject(
        new Error("Failed to execute batched task", { cause: err })
      );
    }
  }
}

function rejectAndRemoveUncloneableBatchItems(
  batchItems: Batch["items"]
): Batch["items"] {
  const cloneable: Batch["items"] = [];
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

function raceBatchStart(batch: Batch) {
  void raceBatchStartImpl(batch);
  return batch.start.promise;
}

async function raceBatchStartImpl(batch: Batch) {
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
// client - blocking response poller
//===============================================

type PollerState = {
  tasks: Map<number, PollerTask<unknown>>;
  loop: Promise<void> | undefined;
};
function createPollerState(): PollerState {
  return {
    tasks: new Map(),
    loop: undefined,
  };
}

function addTaskToPoller(
  client: ChannelClient,
  pollerTask: PollerTask<unknown>
) {
  const { pollerState } = client;
  pollerState.tasks.set(pollerTask.id, pollerTask);
}

function startPolling(client: ChannelClient) {
  const { pollerState } = client;
  if (!pollerState.loop) {
    pollerState.loop = (async () => {
      try {
        await runPollLoopUntilDone(client);
      } catch (err) {
        rejectPendingPollerTasks(pollerState, err);
      } finally {
        pollerState.loop = undefined;
      }
    })();
  }
}

async function runPollLoopUntilDone(client: ChannelClient) {
  const { pollerState } = client;
  while (true) {
    if (!getPendingTaskCount(pollerState)) {
      debug?.("client :: exiting read loop");
      pollerState.tasks.clear();
      return;
    }

    const received = receiveMessageOnPort(client.messagePort);
    debug?.("client :: receiveMessageOnPort", received, received?.message?.id);
    if (!received) {
      // if possible, wait for a batch to start to maximize parallelism
      const wipBatch = client.batch;
      if (wipBatch.items.length > 0) {
        debug?.(`client :: waiting for WIP batch to get submitted`);
        await wipBatch.start.promise;
        continue;
      } else {
        try {
          DANGEROUSLY_blockAndWaitForServer(
            client.buffer,
            client.index,
            `poller`
          );
          continue;
        } catch (err) {
          throw new Error("Invariant: could not perform a blocking wait", {
            cause: err,
          });
        }
      }
    }

    const message = received.message as InternalResponsePayload;
    const taskId = message.id;
    const pollerTask = pollerState.tasks.get(taskId);
    if (!pollerTask) {
      throw new Error(
        `Invariant: poller got message for task that is not waiting (${taskId})`
      );
    }
    pollerState.tasks.delete(taskId);

    debug?.("client :: yielding to task", pollerTask.id);
    settlePromise(pollerTask.controller, message.data);
    // yield and let other code run.
    for (let i = 0; i < POLLER_YIELD_ITERATIONS; i++) {
      await null;
    }
  }
}

function getPendingTaskCount(pollerState: PollerState) {
  let count = 0;
  for (const pollerTask of pollerState.tasks.values()) {
    if (pollerTask.controller.status === "pending") {
      count++;
    }
  }
  return count;
}

function rejectPendingPollerTasks(pollerState: PollerState, error: unknown) {
  for (const pollerTask of pollerState.tasks.values()) {
    pollerTask.controller.reject(
      new Error(
        "Invariant: An internal error occurred while polling, and this task has to be aborted.",
        { cause: error }
      )
    );
  }
  pollerState.tasks.clear();
}

function settlePromise<T>(
  controller: PromiseWithResolvers<T>,
  result: Settled<T, ReturnType<typeof serializeThrown>>
) {
  if (result.status === "fulfilled") {
    controller.resolve(result.value);
  } else {
    controller.reject(deserializeThrown(result.reason));
  }
}

//===============================================
// server - will do work while client is blocked
//===============================================

export function listenForRequests(
  server: ChannelServer,
  handler: (data: any) => Promise<any>
) {
  const cleanups: (() => void)[] = [];

  async function handleEvent(this: MessagePort, rawEvent: Event) {
    const event = rawEvent as MessageEvent;
    const sourcePort = this;

    const message = event.data as InternalMessage;
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
    sourcePort: MessagePort,
    message: InternalCreateClientPayload
  ) {
    const { id, messagePort } = message;

    // TODO: technically, we shouldn't receive control messages on this port,
    // but this is maybe fine...?
    messagePort.addEventListener("message", handleEvent);
    cleanups.push(() =>
      messagePort.removeEventListener("message", handleEvent)
    );

    const responsePayload: InternalCreateClientResultPayload = { id, ok: true };
    sourcePort.postMessage(responsePayload);
  }

  async function handleRequest(
    sourcePort: MessagePort,
    message: InternalRequestPayload
  ) {
    // request
    const { clientIndex, items: requests } = message;
    debug?.(`server :: request from ${clientIndex}`, requests);

    async function safelyRunHandler(
      requestData: unknown
    ): Promise<Settled<unknown, ReturnType<typeof serializeThrown>>> {
      // make sure the `any` on the response type doesn't make us bypass type safety
      const _handler = handler as (arg: unknown) => Promise<unknown>;
      try {
        return { status: "fulfilled", value: await _handler(requestData) };
      } catch (error) {
        // TODO: might need to serialize the error somehow here
        return { status: "rejected", reason: serializeThrown(error) };
      }
    }

    requests.forEach(async (request) => {
      const result = await safelyRunHandler(request.data);
      const responsePayload: InternalResponsePayload = {
        id: request.id,
        data: result,
      };

      debug?.(`server :: sending response (${request.id})`, result);
      try {
        sourcePort.postMessage(responsePayload);
      } catch (err) {
        if (isDataCloneError(err)) {
          // We tried to respond with something uncloneable.
          // find out which results caused this and error them.
          const fallbackResponsePayload: InternalResponsePayload = {
            id: request.id,
            data: replaceUncloneableResultWithError(result),
          };
          sourcePort.postMessage(fallbackResponsePayload);
        } else {
          // nothing more we can do here
          throw err;
        }
      }

      try {
        DANGEROUSLY_maybeWakeBlockedClient(server.buffer, clientIndex);
      } catch (err) {
        throw new Error(`Error while waking client for ${request.id}`, {
          cause: err,
        });
      }
    });
  }

  server.messagePort.addEventListener("message", handleEvent);
  cleanups.push(() =>
    server.messagePort.removeEventListener("message", handleEvent)
  );
  debug?.("server :: listening");

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function replaceUncloneableResultWithError(
  result: InternalResponsePayload["data"]
): InternalResponsePayload["data"] {
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

function isDataCloneError(err: unknown): err is DOMException {
  return !!(
    err &&
    typeof err === "object" &&
    err instanceof DOMException &&
    err.name === "DataCloneError"
  );
}

function serializeThrown(error: unknown) {
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

function deserializeThrown(serialized: ReturnType<typeof serializeThrown>) {
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

function promiseWithResolvers<T>() {
  let resolve: (value: T) => void = undefined!;
  let reject: (error: unknown) => void = undefined!;

  let status: "pending" | "fulfilled" | "rejected" = "pending";

  const promise = new Promise<T>((_resolve, _reject) => {
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
