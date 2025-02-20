// @ts-check
import { createClient, sendRequest } from "../../lib.mjs";
import { workerData as workerDataRaw } from "node:worker_threads";
import { createProxy } from "./cached.mjs";

if (!workerDataRaw) {
  throw new Error("Expected to run within a Worker");
}

/** @typedef {{ clientHandle: import("../../lib.mjs").ChannelClientHandle, id: number }} MainWorkerData */

(async () => {
  /** @type {MainWorkerData} */
  const workerData = workerDataRaw;
  const { clientHandle, id } = workerData;

  console.log(`render-worker ${id} :: hello`);

  const comm = createClient(clientHandle);

  const loremIpsum = createProxy(comm, "loremIpsum");
  const getPost = createProxy(comm, "getPost");
  const unserializableResponse = createProxy(comm, "unserializableResponse");

  setTimeout(() => {
    console.log(`render-worker ${id} :: hello from timeout!`);
  }, 0);

  {
    const completions = [];
    const trackCompletion = (promise, label) => {
      promise.then(() => completions.push(label));
      return promise;
    };
    const equals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    console.log(
      `render-worker ${id} :: sending parallel requests`,
      await Promise.all([
        (async () => {
          await trackCompletion(loremIpsum("1"), `loremIpsum("1")`);
          await trackCompletion(loremIpsum("2"), `loremIpsum("2")`);
        })(),
        trackCompletion(getPost(1), `getPost(1)`),
      ])
    );
    if (
      !equals(completions, [`loremIpsum("1")`, `loremIpsum("2")`, `getPost(1)`])
    ) {
      throw new Error("Wrong order of completions");
    }
  }

  {
    await (console.log(`render-worker ${id} :: loremIpsum("boop")`),
    loremIpsum("boop"));
  }

  {
    console.log(`render-worker ${id} :: sending parallel requests`);
    const responses = await Promise.all([
      (console.log(`render-worker ${id} :: getPost(3)`), getPost(3)),
      (console.log(`render-worker ${id} :: getPost(4)`), getPost(4)),
      (console.log(`render-worker ${id} :: unserializableResponse()`),
      unserializableResponse().catch((err) => err)),
    ]);
    console.log(`render-worker ${id} :: got responses`, responses);
  }

  // Error scenarios

  {
    console.log(
      `render-worker ${id} :: unserializable response`,
      await unserializableResponse().catch((err) => err)
    );
  }

  {
    console.log(
      `render-worker ${id} :: unserializable response in batch`,
      await Promise.all([
        loremIpsum("x"),
        unserializableResponse().catch((err) => err),
      ])
    );
  }

  {
    console.log(
      `render-worker ${id} :: uncloneable argument:`,
      await unserializableResponse({ promise: Promise.resolve() }).catch(
        (err) => err
      )
    );
  }

  {
    console.log(
      `render-worker ${id} :: uncloneable argument in batch:`,
      await Promise.all([
        loremIpsum("x"),
        unserializableResponse({ promise: Promise.resolve() }).catch(
          (err) => err
        ),
      ])
    );
  }

  {
    console.log(
      `render-worker ${id} :: untransferable argument:`,
      await unserializableResponse(new MessageChannel().port1).catch(
        (err) => err
      )
    );
  }

  {
    console.log(
      `render-worker ${id} :: untransferable argument in batch:`,
      await Promise.all([
        loremIpsum("x").catch((err) => err),
        unserializableResponse(new MessageChannel().port1).catch((err) => err),
      ])
    );
  }
})();
