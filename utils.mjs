// @ts-check
import * as crypto from "node:crypto";
import { receiveMessageOnPort, MessageChannel } from "node:worker_threads";

const debug = process.env.DEBUG ? console.log : undefined;

const ARR_INDEX = 0;

const ARR_VALUE_STATE = {
  NOT_DONE: 0,
  DONE: 1,
};

/** @returns {{ client: ChannelEnd, server: ChannelEnd }} */
export function createChannel() {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const asArray = new Int32Array(buffer);
  asArray[ARR_INDEX] = ARR_VALUE_STATE.NOT_DONE;

  const channel = new MessageChannel();

  /**
   * @returns {ChannelEnd}
   * @param {import("node:worker_threads").MessagePort} messagePort
   * @param {SharedArrayBuffer} buffer
   */
  function createChannelEnd(messagePort, buffer) {
    return { messagePort, buffer, transferList: [messagePort] };
  }

  return {
    client: createChannelEnd(channel.port1, buffer),
    server: createChannelEnd(channel.port2, buffer),
  };
}

/** @typedef {{ messagePort: import("node:worker_threads").MessagePort, buffer: SharedArrayBuffer, transferList: import("node:worker_threads").TransferListItem[]  }} ChannelEnd */

const USE_SYNC_MESSAGE_RECEIVE = true;

export function sendRequest(
  /** @type {ChannelEnd} */ comm,
  /** @type {any} */ data,
  /** @type {import("node:worker_threads").TransferListItem[]} */ transfer = []
) {
  return new Promise(async (resolve, reject) => {
    const id = crypto.randomInt(0, Math.pow(2, 48) - 1);

    let timeoutRan = false;
    const timeout = setTimeout(() => {
      timeoutRan = true;
    });

    function handleResponse(/** @type {Event} */ rawEvent) {
      const event = /** @type {MessageEvent} */ (rawEvent);
      const { id: incomingId, data: response } = JSON.parse(event.data);
      if (incomingId !== id) {
        return;
      }

      if (!USE_SYNC_MESSAGE_RECEIVE) {
        comm.messagePort.removeEventListener("message", handleResponse);
        if (timeoutRan) {
          reject(
            new Error(
              "Invariant: Did not receive a response message in under a task"
            )
          );
          return;
        } else {
          clearTimeout(timeout);
        }
      }

      return resolve(response);
    }

    if (!USE_SYNC_MESSAGE_RECEIVE) {
      comm.messagePort.addEventListener("message", handleResponse);
    }

    comm.messagePort.postMessage({ id, data }, transfer);

    // TODO: do we need this? does this help?
    // it lets us run in parallel (because we don't block immediately when creating the promise)
    // but right now the comm channel doesn't allow multiple requests
    // await Promise.resolve();

    const asArray = new Int32Array(comm.buffer);
    debug?.("client :: calling Atomics.wait");
    const waitRes = Atomics.wait(asArray, ARR_INDEX, ARR_VALUE_STATE.NOT_DONE);
    if (waitRes === "not-equal") {
      throw new Error(
        "Invariant: expected to be in NOT_DONE state when calling Atomics.wait"
      );
    }
    debug?.("client :: Atomics.wait returned", waitRes);

    if (USE_SYNC_MESSAGE_RECEIVE) {
      const msg = receiveMessageOnPort(comm.messagePort);
      if (!msg) {
        throw new Error(
          "Expected a response message to be available synchronously"
        );
      }
      return handleResponse(
        /** @type {MessageEvent} */ ({ data: msg.message })
      );
    }
  });
}

export function listenForRequests(
  /** @type {ChannelEnd} */ comm,
  /** @type {(data: any) => Promise<any>} */ handler
) {
  async function handleRequest(/** @type {Event} */ rawEvent) {
    const event = /** @type {MessageEvent} */ (rawEvent);
    const { id, data } = event.data;
    debug?.("server :: request:", data);

    const response = await handler(data);

    debug?.("server :: sending response:", response);
    comm.messagePort.postMessage(JSON.stringify({ id, data: response }));

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
