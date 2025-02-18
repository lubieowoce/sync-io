// @ts-check
import { listenForRequests } from "./utils.mjs";
import { parentPort, workerData as workerDataRaw } from "node:worker_threads";

if (!parentPort) {
  throw new Error("Expected to run within a Worker");
}
console.log("cache-worker :: hello");
parentPort.postMessage("UP");

// require("./native/sync-io.node");

/** @type {{ comm: import("./utils.mjs").ChannelEnd }} */
const workerData = workerDataRaw;
const { comm } = workerData;

// let i = 0;
// let last = Date.now();
// setInterval(() => {
//   const now = Date.now();
//   console.log(
//     "cache-worker :: interval",
//     i++,
//     (now - last).toFixed(1),
//     new Date().toISOString()
//   );
//   last = now;
// }, 100);

listenForRequests(comm, async (request) => {
  console.log("cache-worker :: got request", request);

  // simulate doing actual IO
  await new Promise((resolve) => setTimeout(resolve, 50));

  return "Lorem ipsum, dolor sit amet" + ` (${new Date().toISOString()})`;
});
