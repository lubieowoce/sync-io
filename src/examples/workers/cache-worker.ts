import { type ChannelServer } from "../../lib.js";
import { workerData as workerDataRaw } from "node:worker_threads";
import { runCacheServer } from "./cache-functions.js";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}
console.log("cache-worker :: hello");
export type CacheWorkerData = {
  serverHandle: ChannelServer;
};

const workerData = workerDataRaw as CacheWorkerData;
const { serverHandle } = workerData;
runCacheServer(serverHandle);
