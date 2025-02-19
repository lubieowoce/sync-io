// @ts-check
import { Worker } from "node:worker_threads";
import { createChannel } from "./utils.mjs";

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

  const { clientHandle, server } = createChannel();

  const mainWorker = new Worker(
    new URL(import.meta.resolve("./main-worker.mjs")),
    {
      /** @type {import("./main-worker.mjs").MainWorkerData} */
      workerData: { clientHandle },
      transferList: [...clientHandle.transferList],
    }
  );
  mainWorker.on("error", (err) => {
    console.error("Unhandled error in main worker:", err);
    process.exit(1);
  });

  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./cache-worker.mjs")),
    {
      /** @type {import("./cache-worker.mjs").CacheWorkerData} */
      workerData: { comm: server },
      transferList: [...server.transferList],
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
