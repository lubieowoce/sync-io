// @ts-check
import * as crypto from "node:crypto";
import { receiveMessageOnPort, MessageChannel } from "node:worker_threads";

const debug = process.env.DEBUG ? console.log : undefined;

const ARR_INDEX = 0;

const ARR_VALUE_STATE = {
  NOT_DONE: 0,
  DONE: 1,
};

/** @returns {{ clientHandle: ChannelClientHandle, server: ChannelServer }} */
export function createChannel() {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const asArray = new Int32Array(buffer);
  asArray[ARR_INDEX] = ARR_VALUE_STATE.NOT_DONE;

  const channel = new MessageChannel();

  return {
    clientHandle: {
      messagePort: channel.port1,
      buffer,
      transferList: [channel.port1],
    },
    server: {
      messagePort: channel.port2,
      buffer,
      transferList: [channel.port2],
    },
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

/** @typedef {{ messagePort: import("node:worker_threads").MessagePort, buffer: SharedArrayBuffer, transferList: import("node:worker_threads").TransferListItem[]  }} ChannelEndBase */
/** @typedef {ChannelEndBase} ChannelServer */
/** @typedef {ChannelEndBase} ChannelClientHandle */
/** @typedef {ChannelEndBase & { batch: Batch }} ChannelClient */

/** @typedef {{ id: number, data: unknown[] }} InternalRequestPayload */
/** @typedef {{ id: number, data: Settled<unknown, ReturnType<typeof serializeThrown>>[] }} InternalResponsePayload */

/**
 * @template T, E
 * @typedef {{ status: 'fulfilled', value: T } | { status: 'rejected', reason: E }} Settled<T, E>
 * */

const USE_SYNC_MESSAGE_RECEIVE = true;

export function sendRequest(
  /** @type {ChannelClient} */ comm,
  /** @type {any} */ data,
  /** @type {import("node:worker_threads").TransferListItem[]} */ transfer = []
) {
  const waitUntilBatchEnd = () => Promise.resolve();

  const raceBatchStart = () => {
    const batchLength = comm.batch.items.length;
    waitUntilBatchEnd().then(() => {
      // if the batch length didn't change, i.e.g nothing got added after us,
      // then we're chronologically the last item and our `waitUntilBatchEnd` finished last,
      // so we have to kick off the batch request.
      if (comm.batch.items.length === batchLength) {
        comm.batch.start.resolve();
      }
    });
  };

  // if a batch is ongoing, item 0 will handle sending it and resolving the promise,
  // we just need to register ourselves and bump the start timer.
  if (comm.batch.items.length > 0) {
    const controller = promiseWithResolvers();
    comm.batch.items.push({
      data,
      transfer,
      controller,
    });
    raceBatchStart();
    return controller.promise;
  }

  return new Promise(async (resolve, reject) => {
    const id = crypto.randomInt(0, Math.pow(2, 48) - 1);

    let timeoutRan = false;
    const timeout = setTimeout(() => {
      timeoutRan = true;
    });

    function handleResponse(/** @type {Event} */ rawEvent) {
      const event = /** @type {MessageEvent} */ (rawEvent);
      /** @type {InternalResponsePayload} */
      const { id: incomingId, data: batchResponse } = JSON.parse(event.data);
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
        if (timeoutRan) {
          return rejectBatch(
            new Error(
              "Invariant: Did not receive a response message in under a task"
            )
          );
        } else {
          clearTimeout(timeout);
        }
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
    raceBatchStart();
    await comm.batch.start.promise;

    // we're item 0, so we send the batch
    const requestedBatchItems = comm.batch.items;
    comm.batch = createBatch();

    {
      /** @type {InternalRequestPayload} */
      const requestPayload = {
        id,
        data: requestedBatchItems.map((item) => item.data),
      };
      const requestTransferList = requestedBatchItems.flatMap(
        (item) => item.transfer
      );
      debug?.("client :: sending batch", requestPayload, requestTransferList);

      // TODO: handle messageerror here?
      comm.messagePort.postMessage(requestPayload, requestTransferList);
    }

    const rejectBatch = (/** @type {Error} */ err) => {
      debug?.("client :: rejecting batch", err);
      for (let i = 0; i < requestedBatchItems.length; i++) {
        requestedBatchItems[i].controller.reject(err);
      }
    };

    // block event loop while we wait
    const asArray = new Int32Array(comm.buffer);
    debug?.("client :: calling Atomics.wait");
    const waitRes = Atomics.wait(asArray, ARR_INDEX, ARR_VALUE_STATE.NOT_DONE);
    if (waitRes === "not-equal") {
      return rejectBatch(
        new Error(
          "Invariant: expected to be in NOT_DONE state when calling Atomics.wait"
        )
      );
    }
    debug?.("client :: Atomics.wait returned", waitRes);

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

export function listenForRequests(
  /** @type {ChannelServer} */ comm,
  /** @type {(data: any) => Promise<any>} */ handler
) {
  async function handleRequest(/** @type {Event} */ rawEvent) {
    const event = /** @type {MessageEvent} */ (rawEvent);
    /** @type {InternalRequestPayload} */
    const { id, data: requests } = event.data;
    debug?.("server :: request:", requests);

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
    comm.messagePort.postMessage(JSON.stringify(responsePayload));

    const asArray = new Int32Array(comm.buffer);
    Atomics.store(asArray, ARR_INDEX, ARR_VALUE_STATE.DONE);
    const notifyRes = Atomics.notify(asArray, ARR_INDEX);
    if (notifyRes < 1) {
      throw new Error(
        "Invariant: expected Atomics.notify to wake at least one listener"
      );
    }
    debug?.("server :: notified atomic", notifyRes);
    Atomics.store(asArray, ARR_INDEX, ARR_VALUE_STATE.NOT_DONE);
  }

  comm.messagePort.addEventListener("message", handleRequest);
  return () => comm.messagePort.removeEventListener("message", handleRequest);
}

function serializeThrown(/** @type {unknown} */ error) {
  if (error && typeof error === "object" && error instanceof Error) {
    return {
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
