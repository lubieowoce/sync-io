import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "../lib.js";
import type { CacheWorkerData } from "./workers/cache-worker.js";
import type { MainWorkerData } from "./workers/render-worker.js";

const waitForEnd = async (worker: Worker) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel(2);

  // NOTE: `cacheWorker` must start initializing before we call `createClientHandle`
  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./workers/cache-worker.js")),
    {
      workerData: {
        serverHandle: channel.serverHandle,
      } satisfies CacheWorkerData,
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
      new URL(import.meta.resolve("./workers/render-worker.js")),
      {
        workerData: { clientHandle, id: i } satisfies MainWorkerData,
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
