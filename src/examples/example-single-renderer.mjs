// @ts-check
import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "../lib.mjs";

const waitForBoot = async (
  /** @type {import("node:worker_threads").Worker} */ worker
) => {
  await new Promise((resolve) => worker.on("online", () => resolve(undefined)));
};

const waitForEnd = async (
  /** @type {import("node:worker_threads").Worker} */ worker
) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel();
  const clientHandle = await createClientHandle(channel);

  const mainWorker = new Worker(
    new URL(import.meta.resolve("./workers/render-worker.mjs")),
    {
      /** @type {import("./workers/render-worker.mjs").MainWorkerData} */
      workerData: { clientHandle, id: 1 },
      transferList: [...clientHandle.transferList],
    }
  );
  mainWorker.on("error", (err) => {
    console.error("Unhandled error in main worker:", err);
    process.exit(1);
  });

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

  await Promise.all([waitForBoot(mainWorker), waitForBoot(cacheWorker)]);
  await waitForEnd(mainWorker);
  cacheWorker.terminate();
})();
