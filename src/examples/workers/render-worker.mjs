// @ts-check
import { createClient, sendRequest } from "../../lib.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";
import { createProxy } from "./cached.mjs";

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

  const loremIpsum = createProxy(comm, "loremIpsum");
  const getPost = createProxy(comm, "getPost");

  let timeoutRan = false;
  setTimeout(() => {
    timeoutRan = true;
    console.log(`render-worker ${id} :: hello from timeout!`);
  }, 0);

  await (console.log(`render-worker ${id} :: loremIpsum("boop")`),
  loremIpsum("boop"));

  const responses = await Promise.all([
    (console.log(`render-worker ${id} :: getPost(3)`), getPost(3)),
    (console.log(`render-worker ${id} :: getPost(4)`), getPost(4)),
  ]);

  {
    console.log(`render-worker ${id} :: sending parallel requests`);
    console.log(`render-worker ${id} :: got responses`, responses, {
      timeoutRan,
    });
  }
})();
