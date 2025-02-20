import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "../lib.js";
import type { TestWorkerData } from "./workers/test-worker.js";
import type { CacheWorkerData } from "./workers/cache-worker.js";

const waitForBoot = async (worker: Worker) => {
  await new Promise((resolve) => worker.on("online", () => resolve(undefined)));
};

const waitForEnd = async (worker: Worker) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel();
  const clientHandle = await createClientHandle(channel);

  const mainWorker = new Worker(
    new URL(import.meta.resolve("./workers/test-worker.js")),
    {
      workerData: { clientHandle, id: 1 } as TestWorkerData,
      transferList: [...clientHandle.transferList],
    }
  );
  mainWorker.on("error", (err) => {
    console.error("Unhandled error in main worker:", err);
    process.exit(1);
  });

  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./workers/cache-worker.js")),
    {
      workerData: { serverHandle: channel.serverHandle } as CacheWorkerData,
      transferList: [...channel.serverHandle.transferList],
    }
  );
  cacheWorker.on("error", (err) => {
    console.error("Unhandled error in cache worker:", err);
    process.exit(1);
  });

  await Promise.all([waitForBoot(mainWorker), waitForBoot(cacheWorker)]);
  await waitForEnd(mainWorker);
  cacheWorker.terminate();
})();
