// @ts-check
import { listenForRequests } from "../../lib.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}
console.log("cache-worker :: hello");

const functions = {
  async loremIpsum(/** @type {string} */ arg) {
    console.log("loremIpsum", arg);

    // simulate doing actual IO
    await new Promise((resolve) => setTimeout(resolve, 50));

    return "Lorem ipsum, dolor sit amet" + ` (${new Date().toISOString()})`;
  },
  async getPost(/** @type {number} */ postId) {
    const response = await fetch(
      `https://jsonplaceholder.typicode.com/posts/${postId}`
    );
    if (!response.ok) {
      throw new Error("Failed to fetch");
    }
    /** @type {{userId: number, id: number, title: string, body: string}} */
    const result = await response.json();
    return result;
  },
  async unserializableResponse() {
    return { promise: Promise.resolve("oops") };
  },
};

/** @typedef {{ functionId: string, args: any[] }} CachedFunctionCall */

/** @typedef {typeof functions} CachedFunctions */

/** @typedef {{ serverHandle: import("../../lib.mjs").ChannelServer }} CacheWorkerData */

/** @type {CacheWorkerData} */
const workerData = workerDataRaw;
const { serverHandle } = workerData;

listenForRequests(
  serverHandle,
  async (/** @type {CachedFunctionCall} */ request) => {
    console.log("cache-worker :: got request", request);
    const { functionId, args } = request;
    return functions[functionId](...args);
  }
);
