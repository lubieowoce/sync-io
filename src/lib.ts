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

const ClientState = {
  UNINITIALIZED: 0,
  INITIALIZED: 1,
};

function createStateBuffer(maxClients: number) {
  const buffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * maxClients
  );
  // NOTE: we don't have to initialize the buffer, because UNINITIALIZED is 0
  return buffer;
}

function getMaxNumClients(buffer: SharedArrayBuffer) {
  return buffer.byteLength / Int32Array.BYTES_PER_ELEMENT;
}

function initializeNewClientState(buffer: SharedArrayBuffer) {
  const asArray = new Int32Array(buffer);
  const maxClients = asArray.length;

  if (maxClients === 0) {
    throw new Error("Cannot create client, because maxClients is 0");
  }

  const index = asArray.indexOf(ClientState.UNINITIALIZED);
  if (index === -1) {
    throw new Error(`Cannot create more than ${maxClients} clients`);
  }
  asArray[index] = ClientState.INITIALIZED;
  return index;
}

function DANGEROUSLY_blockAndWaitForServer(
  buffer: SharedArrayBuffer,
  clientIndex: number
) {
  const asArray = new Int32Array(buffer);
  debug?.("client :: calling Atomics.wait");
  const waitRes = Atomics.wait(asArray, clientIndex, ClientState.INITIALIZED);
  if (waitRes === "not-equal") {
    throw new Error(
      "Invariant: expected client state to be INITIALIZED when calling Atomics.wait"
    );
  }
  debug?.("client :: " + "=".repeat(80));
  debug?.("client :: Atomics.wait returned", waitRes);
}

function DANGEROUSLY_maybeWakeBlockedClient(
  buffer: SharedArrayBuffer,
  clientIndex: number
) {
  const asArray = new Int32Array(buffer);
  const notifyRes = Atomics.notify(asArray, clientIndex);
  debug?.("server :: notified atomic", notifyRes);
}

//===============================================
// top-level API
//===============================================

type ChannelEndBase = {
  messagePort: MessagePort;
  buffer: SharedArrayBuffer;
  transferList: TransferListItem[];
};
export type ChannelServer = ChannelEndBase;

type Channel = ReturnType<typeof createChannel>;

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

export type ChannelClientHandle = ChannelEndBase & { index: number };

export async function createClientHandle(
  channel: Channel
): Promise<ChannelClientHandle> {
  const buffer = channel.serverHandle.buffer;
  const index = initializeNewClientState(buffer);
  const maxClients = getMaxNumClients(buffer);

  let clientPort: MessagePort;

  if (maxClients === 1) {
    // there can only ever be one client, so we can use the default port
    // without doing the whole `createClient` message dance
    clientPort = channel.serverMessagePort;
  } else {
    // we need separate ports for each client because each MessagePort can only be transferred once.
    const clientChannel = new MessageChannel();
    clientPort = clientChannel.port1;
    const serverPort = clientChannel.port2;

    await tellServerToListenOnMessagePort(channel, index, serverPort);
  }

  return {
    messagePort: clientPort,
    buffer,
    index,
    transferList: [clientPort],
  };
}

async function tellServerToListenOnMessagePort(
  channel: Channel,
  clientIndex: number,
  messagePort: MessagePort
) {
  await new Promise((resolve, reject) => {
    // TODO: prevent deadlocks here (if no server exists yet and this is awaited, we might never get a reply)
    channel.serverMessagePort.addEventListener(
      "message",
      function handle(rawEvent: Event) {
        const event = rawEvent as MessageEvent;
        const message = event.data as SomeResponseMessage;
        if (message.id !== requestPayload.id) {
          return;
        }
        channel.serverMessagePort.removeEventListener("message", handle);
        const { ok } = message as CreateClientResponseMessage;
        if (!ok) {
          return reject(new Error("Failed to register new client with server"));
        }
        return resolve(undefined);
      }
    );

    const requestPayload: CreateClientRequestMessage = {
      type: "createClient",
      id: randomId(),
      index: clientIndex,
      messagePort: messagePort,
    };
    debug?.("client :: sending createClient message", requestPayload);
    channel.serverMessagePort.postMessage(requestPayload, [
      requestPayload.messagePort,
    ]);
  });
}

export type ChannelClient = Pick<
  ChannelClientHandle,
  "buffer" | "index" | "messagePort"
> & {
  schedulerState: SchedulerState;
};

export function createClient(handle: ChannelClientHandle): ChannelClient {
  isClientWorker = true;

  return {
    ...handle,
    schedulerState: createSchedulerState(),
  };
}

export async function sendRequest(
  client: ChannelClient,
  data: unknown,
  transfer: TransferListItem[] = []
) {
  const item = createWakeableItem();

  // note that this can throw (e.g. because of uncloneable values or incorrect transferList)
  // for this reason, we want to attempt sending the message *before* registering the task --
  // otherwise we might end up with an orphaned task that'd never get awaited OR resolved.
  postRequestMessage(client, item.id, data, transfer);

  // we'll start the scheduler loop (if not running already),
  // let the microtask queue run for a bit more (so that other parallel calls to `sendRequest` can be kicked off)
  // and then eventually blockingly wait for responses.
  registerItemAndBumpYieldDeadline(client, item);

  let immediateRan = false;
  const immediate = setImmediate(() => {
    immediateRan = true;
  });

  try {
    // when the the response to the message arrives, the scheduler will resume us.
    return await item.controller.promise;
  } finally {
    if (immediateRan) {
      throw new Error("Invariant: Did not settle request in under a task");
    } else {
      clearImmediate(immediate);
    }
  }
}

function postRequestMessage(
  client: ChannelClient,
  id: number,
  data: unknown,
  transfer: TransferListItem[] | undefined
) {
  const requestPayload: ItemRequestMessage = {
    type: "request",
    clientIndex: client.index,
    id,
    data,
  };
  debug?.("client :: sending", requestPayload, transfer);
  client.messagePort.postMessage(requestPayload, transfer);
}

//===============================================
// client - scheduler
//===============================================

// this number is a bit arbitrary. once should generally be enough,
// but we do it multiple times to avoid blocking too early and thus maximize parallelism.
const MICROTASK_QUEUE_DRAIN_ITERATIONS = 5;

type WakeableItem<TOut = unknown> = {
  id: number;
  controller: PromiseWithResolvers<TOut>;
};

function createWakeableItem<T>(): WakeableItem<T> {
  return {
    id: randomId(),
    controller: promiseWithResolvers<T>(),
  };
}

type SchedulerState = {
  yieldCounter: number | undefined;
  wakeableItems: Map<number, WakeableItem<unknown>>;
  running: Promise<void> | undefined;
};

function createSchedulerState(): SchedulerState {
  return {
    yieldCounter: undefined,
    wakeableItems: new Map(),
    running: undefined,
  };
}

function resetSchedulerState(schedulerState: SchedulerState) {
  schedulerState.wakeableItems.clear();
  schedulerState.yieldCounter = undefined;
}

function registerItemAndBumpYieldDeadline(
  client: ChannelClient,
  item: WakeableItem
) {
  const { schedulerState } = client;
  // we're either going to be starting the scheduler
  // or the scheduler yielded to us.
  // in either case we want to let other code run for a bit
  // to maximize IO concurrency before we block,
  // so reset the counter.
  bumpYieldDeadline(schedulerState);
  schedulerState.wakeableItems.set(item.id, item);
  startScheduler(client);
}

function bumpYieldDeadline(schedulerState: SchedulerState) {
  schedulerState.yieldCounter = MICROTASK_QUEUE_DRAIN_ITERATIONS;
}

function drainCurrentMicrotaskQueue() {
  // if we're in a microtask, then `process.nextTick` will run
  // when the microtask queue is exhausted, but before anything else.
  // at that point we can schedule more microtasks, and they'll still run before anything else,
  // so this process is repeatable without advancing to the next task.
  // this lets the scheduler loop call and await this functon `MICROTASK_QUEUE_DRAIN_ITERATIONS` times before blocking.
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      process.nextTick(resolve);
    });
  });
}

function startScheduler(client: ChannelClient) {
  const { schedulerState } = client;
  if (!schedulerState.running) {
    schedulerState.running = (async () => {
      try {
        await runSchedulerLoopUntilDone(client);
      } catch (err) {
        rejectPendingItems(schedulerState, err);
      } finally {
        resetSchedulerState(schedulerState);
        schedulerState.running = undefined;
      }
    })();
  }
}

async function runSchedulerLoopUntilDone(client: ChannelClient) {
  const { schedulerState } = client;
  while (true) {
    if (!hasPendingItems(schedulerState)) {
      throw new Error("Invariant: in scheduler loop with no pending items");
    }

    // check if we have got any messages from the server.
    //
    // TODO: can this be a `createClient` message? then the listener wouldn't receive it,
    // because `receiveMessageOnPort` prevents other message listeners from running,
    // and we'll crash below with "Invariant: scheduler got message for item that is not registered"
    const received = receiveMessageOnPort(client.messagePort);

    if (!received) {
      if (schedulerState.yieldCounter === undefined) {
        throw new Error("Invariant: no message available and no yield ongoing");
      }
      if (schedulerState.yieldCounter > 0) {
        // we have no messages to wake items with,
        // and we're currently letting userspace code run for `yieldCounter` more iterations.
        // (we either just started the scheduler from `sendRequest`,
        // got here after receiving messages and waking all their items).
        //
        // the longest timestep we can take while staying within the same task
        // is to wait until the end of the current microtask queue (see `afterCurrentMicrotaskQueue` for details).
        // but note that userspace code can do the same trick (e.g. to implement a dataloader pattern),
        // so we'll still want to do this multiple times to avoid blocking too early.
        debug?.("client :: waiting for the end of the current microtask queue");
        await drainCurrentMicrotaskQueue();
        schedulerState.yieldCounter--;
        continue;
      } else {
        // we have no messages to wake items with,
        // and we're not yielding to userspace anymore.
        // block and wait for new results to make progress.
        try {
          debug?.("client :: blocking");
          DANGEROUSLY_blockAndWaitForServer(client.buffer, client.index);
          // we got woken up, so there should messages ready to read
          // on the next iteration.
          // we'll read those, wake their items, and then start yielding.
          continue;
        } catch (err) {
          throw new Error("Invariant: could not perform a blocking wait", {
            cause: err,
          });
        }
      }
    } else {
      debug?.(
        "client :: got message from `receiveMessageOnPort`",
        received.message.id,
        received.message
      );
      // we got a message and can wake an item.
      const message = received.message as ItemResponseMessage;
      const itemId = message.id;
      const item = schedulerState.wakeableItems.get(itemId);
      if (!item) {
        throw new Error(
          `Invariant: scheduler got message for item that is not registered (${itemId})`
        );
      }
      schedulerState.wakeableItems.delete(itemId);

      debug?.("client :: waking item", item.id);
      // wake up at the end of `sendRequest` (which will then return to userspace).
      settlePromise(item.controller, message.data);

      if (!hasPendingItems(schedulerState)) {
        // we have no pending items, so we're not waiting for any more messages
        // and won't need to do any more blocking. let the rest of the microtask queue run free.
        // we'll either get another `sendRequest` that'll restart the loop,
        // or we'll run out of microtasks and the (node.js event loop) task will finish.
        debug?.("client :: exiting scheduler loop");
        return;
      }

      // we settled the item, and have more items pending.
      // we'll want to yield to userspace to let it progress.
      bumpYieldDeadline(schedulerState);
      // note that if there's more messages in the queue, we'll wake their items before we start yielding.
      // this should hopefully maximize concurrency.
      continue;
    }
  }
}

function hasPendingItems(schedulerState: SchedulerState) {
  return schedulerState.wakeableItems.size > 0;
}

function rejectPendingItems(schedulerState: SchedulerState, error: unknown) {
  for (const item of schedulerState.wakeableItems.values()) {
    item.controller.reject(
      new Error(
        "Invariant: An internal error occurred in the scheduler, and this item has to be aborted.",
        { cause: error }
      )
    );
  }
  schedulerState.wakeableItems.clear();
}

type Settled<T, E> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: E };

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

type SomeRequestMessage = ItemRequestMessage | CreateClientRequestMessage;
type SomeResponseMessage = ItemResponseMessage | CreateClientResponseMessage;

type ItemRequestMessage = {
  type: "request";
  id: number;
  clientIndex: number;
  data: unknown;
};

type ItemResponseMessage = {
  id: number;
  data: Settled<unknown, ReturnType<typeof serializeThrown>>;
};

type CreateClientRequestMessage = {
  type: "createClient";
  id: number;
  index: number;
  messagePort: MessagePort;
};
type CreateClientResponseMessage = { id: number; ok: boolean };

export function listenForRequests(
  server: ChannelServer,
  handler: (data: any) => Promise<any>
) {
  const cleanups: (() => void)[] = [];

  async function handleEvent(this: MessagePort, rawEvent: Event) {
    const event = rawEvent as MessageEvent;
    const sourcePort = this;

    const message = event.data as SomeRequestMessage;
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
    message: CreateClientRequestMessage
  ) {
    const { id, messagePort } = message;

    // TODO: technically, we shouldn't receive control messages on this port,
    // but this is maybe fine...?
    messagePort.addEventListener("message", handleEvent);
    cleanups.push(() =>
      messagePort.removeEventListener("message", handleEvent)
    );

    const responsePayload: CreateClientResponseMessage = {
      id,
      ok: true,
    };
    sourcePort.postMessage(responsePayload);
  }

  async function handleRequest(
    sourcePort: MessagePort,
    request: ItemRequestMessage
  ) {
    debug?.(`server :: request from ${request.clientIndex}`, request.data);

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

    const result = await safelyRunHandler(request.data);
    const responsePayload: ItemResponseMessage = {
      id: request.id,
      data: result,
    };

    debug?.(`server :: sending response (${request.id})`, result);
    try {
      sourcePort.postMessage(responsePayload);
    } catch (err) {
      try {
        // Try sending an error result instead -- maybe the returned value was uncloneable.
        const fallbackResponsePayload: ItemResponseMessage = {
          id: request.id,
          data: { status: "rejected", reason: serializeThrown(err) },
        };
        sourcePort.postMessage(fallbackResponsePayload);
      } catch (secondErr) {
        // If we can't even send an error result, something is very wrong,
        // all we can do is crash (presumably leaving the client hanging forever)
        throw secondErr;
      }
    }

    try {
      DANGEROUSLY_maybeWakeBlockedClient(server.buffer, request.clientIndex);
    } catch (err) {
      throw new Error(`Error while waking client for ${request.id}`, {
        cause: err,
      });
    }
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

//===============================================
// misc
//===============================================

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

type PromiseWithResolvers<T> = ReturnType<typeof promiseWithResolvers<T>>;

function promiseWithResolvers<T>() {
  let resolve: (value: T) => void = undefined!;
  let reject: (error: unknown) => void = undefined!;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function randomId() {
  return crypto.randomInt(0, Math.pow(2, 48) - 1);
}
