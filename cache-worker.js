// @ts-check
console.log("cache-worker :: hello");
require("node:worker_threads").parentPort.postMessage("UP");

// require("./native/sync-io.node");

/** @type {{ channel: MessagePort, buffer: SharedArrayBuffer }} */
const workerData = require("node:worker_threads").workerData;
const { channel, buffer } = workerData;

let i = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  console.log(
    "cache-worker :: interval",
    i++,
    (now - last).toFixed(1),
    new Date().toISOString()
  );
  last = now;
}, 100);

channel.addEventListener("message", (event) => {
  const { id, data } = event.data;
  console.log("cache-worker :: request:", data);

  const response =
    "Lorem ipsum, dolor sit amet" + ` (${new Date().toISOString()})`;

  console.log("cache-worker :: sending response:", response);
  channel.postMessage(JSON.stringify({ id, data: response }));

  const BUFFER_VALUE_DONE = 1;
  const asArray = new Int32Array(buffer);
  Atomics.store(asArray, 0, BUFFER_VALUE_DONE);
  console.log("cache-worker :: notified atomic", Atomics.notify(asArray, 0));
});
