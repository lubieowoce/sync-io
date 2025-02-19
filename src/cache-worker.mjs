// @ts-check
import { listenForRequests } from "./utils.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}
console.log("cache-worker :: hello");

/** @typedef {{ comm: import("./utils.mjs").ChannelServer }} CacheWorkerData */

/** @type {CacheWorkerData} */
const workerData = workerDataRaw;
const { comm } = workerData;

listenForRequests(comm, async (request) => {
  console.log("cache-worker :: got request", request);

  // simulate doing actual IO
  await new Promise((resolve) => setTimeout(resolve, 50));

  return "Lorem ipsum, dolor sit amet" + ` (${new Date().toISOString()})`;
});
