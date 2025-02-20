import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type ChannelClientHandle, type ChannelClient } from "../../lib.js";
import { createProxy } from "./cache-function-proxy.js";

export type MainWorkerData = {
  clientHandle: ChannelClientHandle;
  id: number;
};

export async function runTests(client: ChannelClient, name: string) {
  const loremIpsum = createProxy(client, "loremIpsum");
  const getPost = createProxy(client, "getPost");
  const unserializableResponse = createProxy(client, "unserializableResponse");
  const noop = createProxy(client, "noop");

  setTimeout(() => {
    console.log(`${name} :: hello from timeout!`);
  }, 0);

  await test("interleaved batches", async () => {
    const completions: string[] = [];
    const trackCompletion = <T>(promise: Promise<T>, label: string) => {
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
        () => noop({ promise: Promise.resolve() }),
        /#<Promise> could not be cloned\./,
        undefined
      );
    });

    await test("uncloneable argument in batch", async () => {
      const results = await Promise.allSettled([
        loremIpsum("x"),
        noop({ promise: Promise.resolve() }),
      ]);

      const value0 = assertIsFulfilled(results[0]);
      assertIsLoremIpsum(value0);

      const reason1 = assertIsRejected(results[1]);
      assert.equal(reason1.message, "#<Promise> could not be cloned.");
    });

    await test("untransferable argument", async () => {
      await assert.rejects(
        () => noop(new MessageChannel().port1),
        /Object that needs transfer was found in message but not listed in transferList/,
        undefined
      );
    });

    await test("untransferable argument in batch", async () => {
      const results = await Promise.allSettled([
        loremIpsum("x"),
        noop(new MessageChannel().port1),
      ]);

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
