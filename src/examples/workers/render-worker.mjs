// @ts-check
import { describe, test } from "node:test";
import assert from "node:assert/strict";
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

  const client = createClient(clientHandle);

  const loremIpsum = createProxy(client, "loremIpsum");
  const getPost = createProxy(client, "getPost");
  const unserializableResponse = createProxy(client, "unserializableResponse");

  setTimeout(() => {
    console.log(`render-worker ${id} :: hello from timeout!`);
  }, 0);

  await test("interleaved batches", async () => {
    /** @type {string[]} */
    const completions = [];
    /** @template T */
    const trackCompletion = (
      /** @type {Promise<T>} */ promise,
      /** @type {string} */ label
    ) => {
      promise.then(() => completions.push(label));
      return promise;
    };

    await Promise.all([
      (async () => {
        await trackCompletion(loremIpsum("1"), `loremIpsum("1")`);
        await trackCompletion(loremIpsum("2"), `loremIpsum("2")`);
      })(),
      trackCompletion(getPost(1), `getPost(1)`),
    ]);

    assert.deepStrictEqual(completions, [
      `loremIpsum("1")`,
      `loremIpsum("2")`,
      `getPost(1)`,
    ]);
  });

  await test("single request", async () => {
    const result = await loremIpsum("boop");
    assertIsLoremIpsum(result);
  });

  await test("parallel requests - one batch", async () => {
    const results = await Promise.allSettled([
      getPost(3),
      getPost(4),
      unserializableResponse(),
    ]);
    const value0 = assertIsFulfilled(results[0]);
    assertIsPost(value0, 3);

    const value1 = assertIsFulfilled(results[1]);
    assertIsPost(value1, 4);

    const reason2 = assertIsRejected(results[2]);
    assert.equal(reason2.message, "#<Promise> could not be cloned.");
  });

  await describe("invalid arguments/results", async () => {
    await test("unserializable response", async () => {
      await assert.rejects(
        () => unserializableResponse(),
        /DataCloneError: #<Promise> could not be cloned\./,
        undefined
      );
    });

    await test("unserializable response in batch", async () => {
      const results = await Promise.allSettled([
        loremIpsum("x"),
        unserializableResponse(),
      ]);
      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.equal(reason1.message, "#<Promise> could not be cloned.");
    });

    await test("uncloneable argument", async () => {
      await assert.rejects(
        () => unserializableResponse({ promise: Promise.resolve() }),
        /#<Promise> could not be cloned\./,
        undefined
      );
    });

    await test("uncloneable argument in batch", async () => {
      const results = await Promise.allSettled([
        loremIpsum("x"),
        unserializableResponse({ promise: Promise.resolve() }),
      ]);

      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.equal(reason1.message, "#<Promise> could not be cloned.");
    });

    await test("untransferable argument", async () => {
      await assert.rejects(
        () => unserializableResponse(new MessageChannel().port1),
        /Object that needs transfer was found in message but not listed in transferList/,
        undefined
      );
    });

    await test("untransferable argument in batch", async () => {
      const results = await Promise.allSettled([
        loremIpsum("x"),
        unserializableResponse(new MessageChannel().port1),
      ]);

      // it's a bit unfortunate that we reject the first promise too,
      // but it's hard to do better and it's a hard error anyway
      const reason0 = assertIsRejected(results[0]);
      assert.match(reason0.message, /Failed to execute batched task/);
      assert.match(
        reason0.cause.message,
        /Object that needs transfer was found in message but not listed in transferList/
      );

      const reason1 = assertIsRejected(results[1]);
      assert.match(reason1.message, /Failed to execute batched task/);
      assert.match(
        reason1.cause.message,
        /Object that needs transfer was found in message but not listed in transferList/
      );
    });
  });
})();

/** @returns {asserts bool is true} */
function assertThat(
  /** @type {boolean} */ cond,
  /** @type {string | Error | undefined} */ message = undefined
) {
  return assert.equal(cond, true, message);
}

function assertIsLoremIpsum(/** @type {any} */ value) {
  assert.equal(typeof value, "string");
  assertThat(value.startsWith("Lorem ipsum"));
}

function assertIsPost(/** @type {any} */ value, /** @type {number} */ id) {
  assertThat(value && typeof value === "object");
  assert.equal(typeof value.userId, "number");
  assert.equal(value.id, id);
}

function assertIsFulfilled(/** @type {PromiseSettledResult<any>} */ settled) {
  assertThat(settled && typeof settled === "object");
  assert.equal(settled.status, "fulfilled");
  return settled.value;
}

function assertIsRejected(/** @type {PromiseSettledResult<any>} */ settled) {
  assertThat(settled && typeof settled === "object");
  assert.equal(settled.status, "rejected");
  return settled.reason;
}
