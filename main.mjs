// @ts-check
import { Worker } from "node:worker_threads";
import { createChannel } from "./utils.mjs";

(async () => {
  console.log("root :: hello");

  const waitForBoot = async (
    /** @type {import("node:worker_threads").Worker} */ worker
  ) => {
    await new Promise((resolve) =>
      worker.on("online", () => resolve(undefined))
    );
  };

  const waitForEnd = async (
    /** @type {import("node:worker_threads").Worker} */ worker
  ) => {
    await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
  };

  const { client, server } = createChannel();

  const mainWorker = new Worker(
    new URL(import.meta.resolve("./main-worker.mjs")),
    {
      workerData: { comm: client },
      transferList: [...client.transferList],
    }
  );
  const cacheWorker = new Worker(
    new URL(import.meta.resolve("./cache-worker.mjs")),
    {
      workerData: { comm: server },
      transferList: [...server.transferList],
    }
  );

  await Promise.all([waitForBoot(mainWorker), waitForBoot(cacheWorker)]);
  await waitForEnd(mainWorker);
  cacheWorker.terminate();
})();
