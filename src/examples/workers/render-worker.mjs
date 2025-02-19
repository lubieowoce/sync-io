// @ts-check
import { createClient, sendRequest } from "../../lib.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

/** @typedef {{ clientHandle: import("../../lib.mjs").ChannelClientHandle, id: number }} MainWorkerData */

(async () => {
  /** @type {MainWorkerData} */
  const workerData = workerDataRaw;
  const { clientHandle, id } = workerData;

  console.log(`render-worker ${id} :: hello`);

  const comm = createClient(clientHandle);

  let timeoutRan = false;
  setTimeout(() => {
    timeoutRan = true;
    console.log(`render-worker ${id} :: hello from timeout!`);
  }, 0);

  {
    console.log(`render-worker ${id} :: sending request`);
    const response = await sendRequest(comm, "ping 1");
    console.log(`render-worker ${id} :: got response`, response, {
      timeoutRan,
    });
  }

  {
    console.log(`render-worker ${id} :: sending parallel requests`);
    const responses = await Promise.all([
      (console.log(`render-worker ${id} :: ping 3`),
      sendRequest(comm, "ping 3")),
      (console.log(`render-worker ${id} :: ping 4`),
      sendRequest(comm, "ping 4")),
    ]);
    console.log(`render-worker ${id} :: got responses`, responses, {
      timeoutRan,
    });
  }
})();
