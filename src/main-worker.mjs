// @ts-check
import { createClient, sendRequest } from "./utils.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

/** @typedef {{ clientHandle: import("./utils.mjs").ChannelClientHandle }} MainWorkerData */

(async () => {
  console.log("main-worker :: hello");

  /** @type {MainWorkerData} */
  const workerData = workerDataRaw;
  const { clientHandle } = workerData;

  const comm = createClient(clientHandle);

  let timeoutRan = false;
  setTimeout(() => {
    timeoutRan = true;
    console.log("main-worker :: hello from timeout!");
  }, 0);

  {
    console.log("main-worker :: sending request");
    const response = await sendRequest(comm, "ping 1");
    console.log("main-worker :: got response", response, { timeoutRan });
  }

  {
    console.log("main-worker :: sending parallel requests");
    const responses = await Promise.all([
      (console.log("main-worker :: ping 3"), sendRequest(comm, "ping 3")),
      (console.log("main-worker :: ping 4"), sendRequest(comm, "ping 4")),
    ]);
    console.log("main-worker :: got responses", responses, { timeoutRan });
  }
})();
