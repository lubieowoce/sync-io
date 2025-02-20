// @ts-check
import { createClient, sendRequest } from "../../lib.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";
import { createProxy } from "./cached.mjs";

import * as streamConsumers from "node:stream/consumers";
import * as React from "react";
// @ts-expect-error
import * as RSDWStatic from "react-server-dom-webpack/static";

async function main() {
  const abortController = new AbortController();
  setTimeout(() => {
    console.log("hello from timeout");
  });

  const { prelude: stream } = await prerenderAndAbortInSequentialTasks(
    async () => {
      return RSDWStatic.unstable_prerenderToNodeStream(
        React.createElement(App),
        {},
        { signal: abortController.signal }
      );
    },
    () => {
      console.log("aborting");
      abortController.abort();
    }
  );

  console.log(await streamConsumers.text(stream));
}

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

/** @typedef {{ clientHandle: import("../../lib.mjs").ChannelClientHandle, id: number }} MainWorkerData */

/** @type {MainWorkerData} */
const workerData = workerDataRaw;
const { clientHandle, id } = workerData;

console.log(`render-worker ${id} :: hello`);

const client = createClient(clientHandle);

const loremIpsum = createProxy(client, "loremIpsum");
const getPost = createProxy(client, "getPost");

const taskyAsyncFunction = async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
};

async function App() {
  return React.createElement(
    "main",
    null,
    React.createElement(LoremIpsum),
    React.createElement(Parent),
    React.createElement(
      React.Suspense,
      { fallback: "Loading..." },
      React.createElement(Dynamic)
    )
  );
}

async function Parent() {
  await getPost(1);
  return React.createElement(
    "section",
    null,
    React.createElement(
      React.Suspense,
      { fallback: "Loading..." },
      React.createElement(Dynamic)
    ),
    React.createElement(Post, { id: 1 }),
    React.createElement(Post, { id: 2 }),
    React.createElement(Post, { id: 3 })
  );
}

async function Dynamic() {
  await taskyAsyncFunction();
  console.log("Dynamic is finished");
  return React.createElement("div", null, "Dynamic!");
}

async function Post(/** @type {{ id: number }} */ { id }) {
  const post = await getPost(id);
  return React.createElement(
    "div",
    null,
    React.createElement("h1", null, post.title),
    React.createElement("p", null, post.body)
  );
}

async function LoremIpsum() {
  const text = await loremIpsum("");
  return React.createElement("div", null, text);
}

/**
 * @template R
 * @returns {Promise<R>}
 */
function prerenderAndAbortInSequentialTasks(
  /** @type {() => Promise<R>} */ prerender,
  /** @type {() => void} */ abort
) {
  return new Promise((resolve, reject) => {
    /** @type {Promise<R>} */
    let pendingResult;
    setImmediate(() => {
      try {
        pendingResult = prerender();
        pendingResult.catch(() => {});
      } catch (err) {
        reject(err);
      }
    });
    setImmediate(() => {
      abort();
      resolve(pendingResult);
    });
  });
}

void main();
