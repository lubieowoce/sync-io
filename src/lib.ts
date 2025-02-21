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
    pollerState: createPollerState(),
  };
}

type PromiseWithResolvers<T> = ReturnType<typeof promiseWithResolvers<T>>;

type WakeableItem<TOut = unknown> = {
  id: number;
  controller: PromiseWithResolvers<TOut>;
};

type ChannelEndBase = {
  messagePort: MessagePort;
  buffer: SharedArrayBuffer;
  transferList: TransferListItem[];
};
export type ChannelServer = ChannelEndBase;
export type ChannelClientHandle = ChannelEndBase & { index: number };
export type ChannelClient = ChannelClientHandle & {
  pollerState: PollerState;
};

type InternalMessage = InternalRequestPayload | InternalCreateClientPayload;
type InternalRequestPayload = {
  type: "request";
  id: number;
  clientIndex: number;
  data: unknown;
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

const YIELD_ITERATIONS = 100; // arbitrary long-ish number (still much cheaper than serializing IO)

export async function sendRequest(
  client: ChannelClient,
  data: unknown,
  transfer: TransferListItem[] = []
) {
  let timeoutRan = false;
  const timeout = setTimeout(() => {
    timeoutRan = true;
  });

  const resultController = promiseWithResolvers();

  const item: WakeableItem = {
    id: randomId(),
    controller: resultController,
  };
  postRequestMessage(client, item.id, data, transfer);
  registerWakeableAndBumpYieldDeadline(client, item);

  try {
    return await resultController.promise;
  } finally {
    if (timeoutRan) {
      throw new Error("Invariant: Did not settle request in under a task");
    } else {
      clearTimeout(timeout);
    }
  }
}

function postRequestMessage(
  client: ChannelClient,
  id: number,
  data: unknown,
  transfer: TransferListItem[] | undefined
) {
  const requestPayload: InternalRequestPayload = {
    type: "request",
    clientIndex: client.index,
    id,
    data,
  };
  debug?.("client :: sending", requestPayload, transfer);
  client.messagePort.postMessage(requestPayload, transfer);
}

//===============================================
// client - blocking response poller
//===============================================

type PollerState = {
  yieldCounter: number | undefined;
  tasks: Map<number, PollerTask<unknown>>;
  loop: Promise<void> | undefined;
};
function createPollerState(): PollerState {
  return {
    yieldCounter: undefined,
    tasks: new Map(),
    loop: undefined,
  };
}

function registerWakeableAndBumpYieldDeadline(
  client: ChannelClient,
  item: WakeableItem
) {
  const { pollerState } = client;
  // we're either going to be starting the poller
  // or the poller yielded to us.
  // in either case we want to let other code run for a bit
  // to maximize IO concurrency before we block,
  // so reset the counter.
  bumpYieldDeadline(pollerState);
  pollerState.tasks.set(item.id, item);
  startPolling(client);
}

function bumpYieldDeadline(pollerState: PollerState) {
  pollerState.yieldCounter = YIELD_ITERATIONS;
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
      // we have no pending tasks, so we're not waiting for any more messages.
      // let go of the microtask queue.
      // we'll either get another `sendRequest` that'll restart the loop
      // or we're out of work and the task will finish.
      debug?.("client :: exiting poller loop");
      pollerState.tasks.clear();
      pollerState.yieldCounter = undefined;
      return;
    }

    const received = receiveMessageOnPort(client.messagePort);
    debug?.("client :: receiveMessageOnPort", received, received?.message?.id);

    if (!received) {
      if (pollerState.yieldCounter === undefined) {
        throw new Error("Invariant: no message available and no yield ongoing");
      }
      if (pollerState.yieldCounter > 0) {
        // we have pending tasks, no messages to wake tasks with,
        // and we're currently letting userspace code run for `yieldCounter` more iterations.
        // (we either just started polling and came here from `sendRequest`,
        // or after receiving messages and waking all the tasks).
        //
        // yield.
        await null;
        pollerState.yieldCounter--;
        continue;
      } else {
        // we have pending tasks, no more messages to wake tasks with,
        // and we're not yielding to userspace anymore.
        // block and wait for new results to make progress.
        try {
          DANGEROUSLY_blockAndWaitForServer(client.buffer, client.index);
          // we got woken up, so there should messages ready to read
          // on the next iteration.
          // we'll read those, wake their tasks, and then start yielding.
          continue;
        } catch (err) {
          throw new Error("Invariant: could not perform a blocking wait", {
            cause: err,
          });
        }
      }
    } else {
      // we have pending tasks, and got a message that we can wake a task with.
      const message = received.message as InternalResponsePayload;
      const taskId = message.id;
      const pollerTask = pollerState.tasks.get(taskId);
      if (!pollerTask) {
        throw new Error(
          `Invariant: poller got message for task that is not registered (${taskId})`
        );
      }
      pollerState.tasks.delete(taskId);

      if (pollerTask.controller.status !== "pending") {
        throw new Error(
          `Invariant: poller got message for task that is already ${pollerTask.controller.status}`
        );
      }

      debug?.("client :: waking task", pollerTask.id);
      // wake up at the end of `sendRequest` (which will then return to userspace).
      settlePromise(pollerTask.controller, message.data);

      // now that we settled the task, we'll want to yield to userspace to let it progress.
      // but if there's more messages in the queue, we'll wake their tasks before we start yielding.
      // this should hopefully maximize concurrency.
      bumpYieldDeadline(pollerState);
      continue;
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

    const responsePayload: InternalCreateClientResultPayload = {
      id,
      ok: true,
    };
    sourcePort.postMessage(responsePayload);
  }

  async function handleRequest(
    sourcePort: MessagePort,
    request: InternalRequestPayload
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
    const responsePayload: InternalResponsePayload = {
      id: request.id,
      data: result,
    };

    debug?.(`server :: sending response (${request.id})`, result);
    try {
      sourcePort.postMessage(responsePayload);
    } catch (err) {
      try {
        // Try sending an error result instead -- maybe the returned value was uncloneable.
        const fallbackResponsePayload: InternalResponsePayload = {
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
