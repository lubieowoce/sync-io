import { workerData as workerDataRaw } from "node:worker_threads";
import { createClient, type ChannelClientHandle } from "../../lib.js";
import { runTests } from "./test-react.js";

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

  console.log(`react-worker ${id} :: hello`);

  const client = createClient(clientHandle);
  await runTests(client);
}

main();
