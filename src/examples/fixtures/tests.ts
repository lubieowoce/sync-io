import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type ChannelClientHandle, type ChannelClient } from "../../lib.js";
import { createProxy } from "./cache-function-proxy.js";
import { inspect } from "node:util";

export type MainWorkerData = {
  clientHandle: ChannelClientHandle;
  id: number;
};

export async function runTests(client: ChannelClient, name: string) {
  const loremIpsum = createProxy(client, "loremIpsum");
  const getPost = createProxy(client, "getPost");
  const getMultipleItems = createProxy(client, "getMultipleItems");
  const unserializableResponse = createProxy(client, "unserializableResponse");
  const noop = createProxy(client, "noop");

  await test("single request", async () => {
    const result = await expectToRunInLessThanATask(() => loremIpsum("boop"));
    assertIsLoremIpsum(result);
  });

  await test("parallel requests", async () => {
    const results = await expectToRunInLessThanATask(() =>
      Promise.allSettled([getPost(3), getPost(4), unserializableResponse()])
    );
    const value0 = assertIsFulfilled(results[0]);
    assertIsPost(value0, 3);

    const value1 = assertIsFulfilled(results[1]);
    assertIsPost(value1, 4);

    const reason2 = assertIsRejected(results[2]);
    assert.equal(reason2.message, "#<Promise> could not be cloned.");
  });

  await test("interleaved parallelizable requests", async () => {
    const completions: string[] = [];
    const trackCompletion = <T>(promise: Promise<T>, label: string) => {
      promise.then(() => completions.push(label));
      return promise;
    };

    await expectToRunInLessThanATask(() =>
      Promise.all([
        (async () => {
          // if we're parallelizing things correctly, both of the loremIpsum calls should finish before getPost does.
          await trackCompletion(loremIpsum("1", 10), `loremIpsum("1")`);
          await trackCompletion(loremIpsum("2", 10), `loremIpsum("2")`);
        })(),
        trackCompletion(getPost(1, 50), `getPost(1)`),
      ])
    );

    assert.deepStrictEqual(completions, [
      `loremIpsum("1")`,
      `loremIpsum("2")`,
      `getPost(1)`,
    ]);
  });

  await describe("invalid arguments/results", async () => {
    await test("unserializable response", async () => {
      await assert.rejects(
        expectToRunInLessThanATask(() => unserializableResponse()),
        /DataCloneError: #<Promise> could not be cloned\./,
        undefined
      );
    });

    await test("unserializable response in parallel requests", async () => {
      const results = await expectToRunInLessThanATask(() =>
        Promise.allSettled([loremIpsum("x"), unserializableResponse()])
      );
      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.equal(reason1.message, "#<Promise> could not be cloned.");
    });

    await test("uncloneable argument", async () => {
      await assert.rejects(
        expectToRunInLessThanATask(() => noop({ promise: Promise.resolve() })),
        /#<Promise> could not be cloned\./,
        undefined
      );
    });

    await test("uncloneable argument in batch", async () => {
      const results = await expectToRunInLessThanATask(() =>
        Promise.allSettled([
          loremIpsum("x"),
          noop({ promise: Promise.resolve() }),
        ])
      );

      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.equal(reason1.message, "#<Promise> could not be cloned.");
    });

    await test("untransferable argument", async () => {
      await assert.rejects(
        expectToRunInLessThanATask(() => noop(new MessageChannel().port1)),
        /Object that needs transfer was found in message but not listed in transferList/,
        undefined
      );
    });

    await test("untransferable argument in batch", async () => {
      const results = await expectToRunInLessThanATask(() =>
        Promise.allSettled([loremIpsum("x"), noop(new MessageChannel().port1)])
      );

      // it's a bit unfortunate that we reject the first promise too,
      // but it's hard to do better and it's a hard error anyway
      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.match(
        reason1.message,
        /Object that needs transfer was found in message but not listed in transferList/
      );
    });
  });

  await describe("userspace waiting for the end of the microtask queue", async () => {
    // duplicate of the function used by our scheduler. see the original for more detail.
    function drainCurrentMicrotaskQueue() {
      return new Promise<void>((resolve) => {
        queueMicrotask(() => {
          process.nextTick(resolve);
        });
      });
    }

    await test("twice", async () => {
      const completions: string[] = [];
      const trackCompletion = <T>(promise: Promise<T>, label: string) => {
        promise.then(() => completions.push(label));
        return promise;
      };

      await expectToRunInLessThanATask(() =>
        Promise.all([
          // wait for the microtask queue to be exhausted
          drainCurrentMicrotaskQueue().then(() =>
            Promise.all([
              trackCompletion(loremIpsum("1", 20), `loremIpsum("1")`),
              trackCompletion(loremIpsum("2", 20), `loremIpsum("2")`),
              // wait for the microtask queue to be exhausted AGAIN
              drainCurrentMicrotaskQueue().then(() =>
                // this has the shortest delay, so assuming all three calls run in parallel, it should finish first
                trackCompletion(loremIpsum("1", 10), `loremIpsum("3")`)
              ),
            ])
          ),
        ])
      );
      assert.deepStrictEqual(completions, [
        `loremIpsum("3")`,
        `loremIpsum("1")`,
        `loremIpsum("2")`,
      ]);
    });

    await test("userspace dataloader", async () => {
      // a simple dataloader-style batcher/deduper
      // that executes a batched request after the current microtask queue is exhausted.
      // this is notable because we use the same `afterCurrentMicrotaskQueue` trick in our scheduler,
      // but want to allow userspace code to be able to do it too.
      const createDataLoader = <TArg, TRes>(
        requestBatch: (args: TArg[]) => Promise<TRes[]>
      ) => {
        function promiseWithResolvers<T>() {
          let resolve: (value: T) => void = undefined!;
          let reject: (error: unknown) => void = undefined!;

          const promise = new Promise<T>((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
          });
          return {
            promise,
            resolve,
            reject,
          };
        }

        type PromiseWithResolvers<T> = ReturnType<
          typeof promiseWithResolvers<T>
        >;

        let pendingBatch: Promise<void> | undefined;
        const batchItems = new Map<TArg, PromiseWithResolvers<TRes>>();
        return {
          get(arg: TArg): Promise<TRes> {
            let batchItem = batchItems.get(arg);
            if (!batchItem) {
              batchItem = promiseWithResolvers<TRes>();
              batchItems.set(arg, batchItem);

              if (!pendingBatch) {
                pendingBatch = drainCurrentMicrotaskQueue().then(async () => {
                  const entries = [...batchItems.entries()];
                  // we don't care about deduping across batches.
                  batchItems.clear();
                  // if more calls to get() come in while we're waiting, they should start a new batch.
                  pendingBatch = undefined;

                  const results = await requestBatch(
                    entries.map(([arg]) => arg)
                  ).then(
                    (value) => ({ type: "ok", value } as const),
                    (error: unknown) => ({ type: "error", error } as const)
                  );

                  for (let i = 0; i < entries.length; i++) {
                    const [, controller] = entries[i];
                    if (results.type === "ok") {
                      controller.resolve(results.value[i]);
                    } else {
                      controller.reject(results.error);
                    }
                  }
                });
              }
            }
            return batchItem.promise;
          },
        };
      };

      const completions: string[] = [];
      const trackCompletion = <T>(promise: Promise<T>, label: string) => {
        promise.then(() => completions.push(label));
        return promise;
      };

      // the requests that go through the dataloader are only delayed by 10,
      // so if the scheduler works right and lets the dataloader execute the batch before blocking,
      // they should resolve before `loremIpsum` does, because we delay that by 20.
      const dataLoader = createDataLoader((args: string[]) =>
        getMultipleItems(args, 10)
      );

      await expectToRunInLessThanATask(() =>
        Promise.all([
          // these two will run immediately
          trackCompletion(loremIpsum("1", 20), `loremIpsum("1")`),
          // the dataloader will execute a request for these two after the current microtask queue
          trackCompletion(dataLoader.get("1"), `dataLoader.get("1")`),
          trackCompletion(dataLoader.get("2"), `dataLoader.get("2")`),
          // this will also execute after the current microtask queue,
          // after the dataloader executed a request for the two calls above.
          // this will start a new batch, so the dataloader will wait
          // for the microtask queue to be exhausted *a second time* before executing the request.
          drainCurrentMicrotaskQueue().then(() =>
            trackCompletion(dataLoader.get("3"), `dataLoader.get("3")`)
          ),
        ])
      );

      assert.deepStrictEqual(completions, [
        `dataLoader.get("1")`,
        `dataLoader.get("2")`,
        `dataLoader.get("3")`,
        `loremIpsum("1")`,
      ]);
    });
  });
}

async function expectToRunInLessThanATask<T>(body: () => T): Promise<T> {
  let immediateRan = false;
  const immediate = setImmediate(() => {
    immediateRan = true;
  });
  try {
    return await body();
  } finally {
    assert.notEqual(immediateRan, true, "Did not finish in less than a task");
    clearImmediate(immediate);
  }
}

function assertThat(
  cond: boolean,
  message: string | Error | undefined = undefined
): asserts cond is true {
  return assert.equal(cond, true, message);
}

function assertIsLoremIpsum(value: any) {
  assert.equal(typeof value, "string");
  assertThat(value.startsWith("Lorem ipsum"));
}

function assertIsPost(value: any, id: number) {
  assertThat(value && typeof value === "object");
  assert.equal(typeof value.userId, "number");
  assert.equal(value.id, id);
}

function assertIsFulfilled(settled: PromiseSettledResult<any>) {
  assertThat(settled && typeof settled === "object");
  assert.equal(settled.status, "fulfilled");
  return settled.value;
}

function assertIsRejected(settled: PromiseSettledResult<any>) {
  assertThat(settled && typeof settled === "object");
  assert.equal(settled.status, "rejected");
  return settled.reason;
}
