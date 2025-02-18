// @ts-check
(async () => {
  console.log("main-worker :: hello");
  require("node:worker_threads").parentPort.postMessage("UP");

  const { styleText } = require("node:util");
  // const { sleepSync, awaitSync, getExample } = require("./native/sync-io.node");

  /** @type {{ channel: MessagePort, buffer: SharedArrayBuffer }} */
  const workerData = require("node:worker_threads").workerData;
  const { channel, buffer } = workerData;

  let timeoutRan = false;
  setTimeout(() => {
    timeoutRan = true;
    console.log("main-worker :: hello from timeout!");
  }, 0);

  const BUFFER_VALUE_NOT_DONE = 0;
  const BUFFER_VALUE_DONE = 1;
  function sendRequestMessage(
    /** @type {any} */ data,
    /** @type {Transferable[]} */ transfer = []
  ) {
    return new Promise((resolve) => {
      const id = require("node:crypto").randomInt(0, Math.pow(2, 48) - 1);
      channel.addEventListener("message", function handle(event) {
        const { id: incomingId, data: response } = JSON.parse(event.data);
        if (incomingId !== id) {
          return;
        }
        resolve(response);
        channel.removeEventListener("message", handle);
      });
      channel.postMessage({ id, data }, transfer);
    });
  }

  const data = "ping";

  console.log("main-worker :: sending request");
  const responsePromise = sendRequestMessage(data);

  const asArray = new Int32Array(buffer);
  console.log("main-worker :: calling Atomics.wait");
  const waitRes = Atomics.wait(asArray, 0, BUFFER_VALUE_NOT_DONE);
  console.log("main-worker :: Atomics.wait returned", waitRes);

  const response = await responsePromise;
  console.log("main-worker :: got response", response, { timeoutRan });

  require("node:worker_threads").parentPort.postMessage("DONE");

  // console.log("main-worker :: calling awaitSync");
  // const res = awaitSync(responsePromise);
  // console.log("awaitSync returned", res);

  // const before = performance.now();
  // console.log("main-worker :: calling sleepSync");
  // const res = sleepSync(1500);
  // console.log(
  //   "main-worker :: sleepSync returned",
  //   performance.now() - before,
  //   new Date().toISOString()
  // );
})();

// it seems that blocking the parent worker also blocks the workers that it spawned
// kinda weird... but sure?
// which means we need
// 0. root
//   1. main-worker - will get blocked
//   2. cache-worker - will perform cached io
