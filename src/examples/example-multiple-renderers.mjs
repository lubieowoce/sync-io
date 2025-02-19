// @ts-check
import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "../lib.mjs";

const waitForEnd = async (
  /** @type {import("node:worker_threads").Worker} */ worker
) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel(2);

  // NOTE: `cacheWorker` must start initializing before we call `createClientHandle`
  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./workers/cache-worker.mjs")),
    {
      /** @type {import("./workers/cache-worker.mjs").CacheWorkerData} */
      workerData: { serverHandle: channel.serverHandle },
      transferList: [...channel.serverHandle.transferList],
    }
  );
  cacheWorker.on("error", (err) => {
    console.error("Unhandled error in cache worker:", err);
    process.exit(1);
  });

  /** @type {Worker[]} */
  const mainWorkers = [];
  for (let i = 1; i <= 2; i++) {
    const clientHandle = await createClientHandle(channel);
    const mainWorker = new Worker(
      new URL(import.meta.resolve("./workers/render-worker.mjs")),
      {
        /** @type {import("./workers/render-worker.mjs").MainWorkerData} */
        workerData: { clientHandle, id: i },
        transferList: [...clientHandle.transferList],
      }
    );
    mainWorkers.push(mainWorker);
    mainWorker.on("error", (err) => {
      console.error("Unhandled error in main worker:", err);
      process.exit(1);
    });
  }

  await Promise.all(mainWorkers.map((mainWorker) => waitForEnd(mainWorker)));
  cacheWorker.terminate();
})();
