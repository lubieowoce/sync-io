import { Worker } from "node:worker_threads";
import { createChannel, createClientHandle } from "../lib.js";
import { runCacheServer } from "./fixtures/cache-functions.js";
import type { ReactWorkerData } from "./workers/react-worker.js";

const waitForEnd = async (worker: Worker) => {
  await new Promise((resolve) => worker.on("exit", () => resolve(undefined)));
};

(async () => {
  console.log("root :: hello");

  const channel = createChannel(1);
  runCacheServer(channel.serverHandle);

  const clientHandle = await createClientHandle(channel);

  const reactWorker = new Worker(
    new URL(import.meta.resolve("./workers/react-worker.js")),
    {
      workerData: { clientHandle, id: 1 } satisfies ReactWorkerData,
      transferList: [...clientHandle.transferList],
    }
  );
  reactWorker.on("error", (err) => {
    console.error("Unhandled error in react worker:", err);
    process.exit(1);
  });

  await waitForEnd(reactWorker);
})();
