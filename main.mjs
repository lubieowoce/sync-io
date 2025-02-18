import { Worker } from "node:worker_threads";
import { createChannel } from "./utils.mjs";

function promiseWithResolvers() {
  let resolve, reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

(async () => {
  console.log("root :: hello");

  const waitForBoot = async (worker) => {
    await new Promise((resolve) =>
      worker.on("message", function handler(value) {
        if (value === "UP") {
          resolve();
          worker.off("message", handler);
        }
      })
    );
  };

  const waitForEnd = async (worker) => {
    await new Promise(
      (resolve) => worker.on("exit", () => resolve())
      // worker.on("message", function handler(value) {
      //   if (value === "DONE") {
      //     resolve();
      //     worker.off("message", handler);
      //   }
      // })
    );
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
