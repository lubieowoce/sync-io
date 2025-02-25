import { type ChannelClient } from "../../lib.js";
import { createProxy } from "./cache-function-proxy.js";

import * as React from "react";
// @ts-expect-error
import * as RSDWStatic from "react-server-dom-webpack/static";

import type { Readable } from "node:stream";
import * as streamConsumers from "node:stream/consumers";

export async function runTests(client: ChannelClient) {
  const loremIpsum = createProxy(client, "loremIpsum");
  const getPost = createProxy(client, "getPost");

  async function taskyAsyncFunction() {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function App() {
    return (
      <main>
        <LoremIpsum />
        <Posts />
        <React.Suspense fallback="Loading...">
          <Dynamic />
        </React.Suspense>
      </main>
    );
  }

  async function Posts() {
    await getPost(10);
    return (
      <section>
        <React.Suspense fallback="Loading...">
          <Dynamic />
        </React.Suspense>
        <Post id={1} />
        <Post id={2} />
        <Post id={3} />
      </section>
    );
  }

  async function Dynamic() {
    await taskyAsyncFunction();
    console.log("Dynamic is finished");
    return <div>Dynamic!</div>;
  }

  async function Post({ id }: { id: number }) {
    const post = await getPost(id);
    return (
      <div>
        <h1>{post.title}</h1>
        <p>{post.body}</p>
      </div>
    );
  }

  async function LoremIpsum() {
    const text = await loremIpsum("");
    return <div>{text}</div>;
  }

  //===========================================================

  function prerenderAndAbortInSequentialTasks<R>(
    prerender: () => Promise<R>,
    abort: () => void
  ): Promise<R> {
    return new Promise((resolve, reject) => {
      let pendingResult: Promise<R>;
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
      ) as Promise<{ prelude: Readable }>;
    },
    () => {
      console.log("aborting");
      abortController.abort();
    }
  );

  console.log(await streamConsumers.text(stream));
}
