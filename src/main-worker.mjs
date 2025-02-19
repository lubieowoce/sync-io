// @ts-check
import { createClient, sendRequest } from "./utils.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

/** @typedef {{ clientHandle: import("./utils.mjs").ChannelClientHandle, id: number }} MainWorkerData */

(async () => {
  /** @type {MainWorkerData} */
  const workerData = workerDataRaw;
  const { clientHandle, id } = workerData;

  console.log(`main-worker ${id} :: hello`);

  const comm = createClient(clientHandle);

  let timeoutRan = false;
  setTimeout(() => {
    timeoutRan = true;
    console.log(`main-worker ${id} :: hello from timeout!`);
  }, 0);

  {
    console.log(`main-worker ${id} :: sending request`);
    const response = await sendRequest(comm, "ping 1");
    console.log(`main-worker ${id} :: got response`, response, { timeoutRan });
  }

  {
    console.log(`main-worker ${id} :: sending parallel requests`);
    const responses = await Promise.all([
      (console.log(`main-worker ${id} :: ping 3`), sendRequest(comm, "ping 3")),
      (console.log(`main-worker ${id} :: ping 4`), sendRequest(comm, "ping 4")),
    ]);
    console.log(`main-worker ${id} :: got responses`, responses, {
      timeoutRan,
    });
  }
})();
