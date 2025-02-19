// @ts-check
import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "./utils.mjs";

const waitForEnd = async (
  /** @type {import("node:worker_threads").Worker} */ worker
) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel();

  // NOTE: `cacheWorker` start initializing before we call `createClientHandle`
  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./cache-worker.mjs")),
    {
      /** @type {import("./cache-worker.mjs").CacheWorkerData} */
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
      new URL(import.meta.resolve("./main-worker.mjs")),
      {
        /** @type {import("./main-worker.mjs").MainWorkerData} */
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
