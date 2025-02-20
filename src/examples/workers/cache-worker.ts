import { listenForRequests, type ChannelServer } from "../../lib.js";
import { workerData as workerDataRaw } from "node:worker_threads";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}
console.log("cache-worker :: hello");

const GET_POST_MOCK = true;

type Post = { userId: number; id: number; title: string; body: string };

const functions = {
  async loremIpsum(arg: string) {
    console.log("loremIpsum", arg);

    // simulate doing actual IO
    await new Promise((resolve) => setTimeout(resolve, 50));

    return "Lorem ipsum, dolor sit amet" + ` (${new Date().toISOString()})`;
  },

  async getPost(postId: number): Promise<Post> {
    if (GET_POST_MOCK) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        userId: 1,
        id: postId,
        title: "Test",
        body: "Lorem ipsum dolor sit amet",
      };
    } else {
      const response = await fetch(
        `https://jsonplaceholder.typicode.com/posts/${postId}`
      );
      if (!response.ok) {
        throw new Error(`Request not ok: ${response.status}`);
      }
      const result = await response.json();
      return result as Post;
    }
  },

  async unserializableResponse() {
    return { promise: Promise.resolve("oops") };
  },
};

export type CachedFunctionCall = { functionId: string; args: any[] };
export type CachedFunctions = typeof functions;

export type CacheWorkerData = {
  serverHandle: ChannelServer;
};

const workerData = workerDataRaw as CacheWorkerData;
const { serverHandle } = workerData;

listenForRequests(serverHandle, async (request: CachedFunctionCall) => {
  console.log("cache-worker :: got request", request);
  const { functionId, args } = request;

  const func: (...args: any[]) => unknown =
    functions[functionId as keyof typeof functions];

  return func(...args);
});
