// @ts-check
import { sendRequest } from "./utils.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

(async () => {
  console.log("main-worker :: hello");

  /** @type {{ comm: import("./utils.mjs").ChannelEnd }} */
  const workerData = workerDataRaw;
  const { comm } = workerData;

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
    console.log("main-worker :: sending request");
    const response = await sendRequest(comm, "ping 2");
    console.log("main-worker :: got response", response, { timeoutRan });
  }

  {
    // TODO: these are not actually parallel! each blocks synchronously...
    console.log("main-worker :: sending parallel requests");
    const responses = await Promise.all([
      (console.log("main-worker :: ping 3"), sendRequest(comm, "ping 3")),
      (console.log("main-worker :: ping 4"), sendRequest(comm, "ping 4")),
    ]);
    console.log("main-worker :: got responses", responses, { timeoutRan });
  }
})();
