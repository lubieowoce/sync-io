import { workerData as workerDataRaw } from "node:worker_threads";
import { createClient, type ChannelClientHandle } from "../../lib.js";
import { runTests } from "./tests.js";

export type MainWorkerData = {
  clientHandle: ChannelClientHandle;
  id: number;
};

async function main() {
  if (!workerDataRaw) {
    throw new Error("Expected to run within a Worker");
  }
  const workerData = workerDataRaw as MainWorkerData;
  const { clientHandle, id } = workerData;

  const name = `render-worker ${id}`;

  console.log(`${name} :: hello`);

  const client = createClient(clientHandle);
  await runTests(client, name);
}
main();
