function promiseWithResolvers() {
  let resolve, reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

// (async () => {
//   const { sleepSync: sleepSync } = require("./native/sync-io.node");

//   async function performCachedIO(batch) {
//     // simulate doing the IO synchronously
//     sleepSync(100);
//     // resolve the batch
//     await Promise.all(
//       batch.map(async (item) => {
//         const { ctrl, fn, args } = item;
//         try {
//           const res = await fn(...args);
//           ctrl.resolve(res);
//         } catch (err) {
//           ctrl.reject(err);
//         }
//       })
//     );
//     batch.length = 0;
//   }

//   setTimeout(() => {
//     console.log("a task has passed");
//   });

//   const batch = [];

//   function cached(fn) {
//     return async (...args) => {
//       await null;
//       console.log("cached:", fn.name ?? "<anonymous>");
//       const ctrl = promiseWithResolvers();
//       batch.push({ ctrl, fn, args });
//       return await ctrl.promise;
//     };
//   }

//   const foo = cached(async function foo(arg) {
//     console.log("foo", arg);
//     return { arg };
//   });

//   let done = Promise.all([foo(3), foo(100)]);

//   console.log("waiting a bunch of microtasks");
//   console.log("batch length", batch.length);
//   let last = batch.length;
//   for (let i = 0; i < 1000; i++) {
//     await Promise.resolve(null);
//     if (batch.length !== last) {
//       console.log("new batch length", batch.length);
//       last = batch.length;
//     }
//   }
//   console.log("performing io synchronously");
//   performCachedIO(batch);

//   await done.finally(() => "done settled");
// })();

// (async () => {
//   const { sleepSync } = require("./native/sync-io.node");
//   setTimeout(() => console.log("hello from timeout!"), 100);
//   console.log("calling sleepSync");
//   sleepSync(1000);
//   console.log("woke up from sleepSync");
// })();

// (async () => {
//   const { awaitSync } = require("./native/sync-io.node");
//   setTimeout(() => console.log("hello from timeout!"), 100);
//   console.log("calling awaitSync");
//   const res = awaitSync(
//     new Promise((resolve) => setTimeout(resolve, 500)).then(() => 0)
//   );
//   console.log("awaitSync returned", res);
// })();

// (async () => {
//   const { sleepSync } = require("./native/sync-io.node");
//   const { Worker } = require("node:worker_threads");

//   console.log("creating worker");
//   const worker = new Worker(require.resolve("./worker"));
//   await new Promise((resolve) =>
//     worker.once("message", (value) => {
//       resolve();
//     })
//   );
//   await new Promise((resolve) => setTimeout(resolve, 200));

//   setTimeout(() => console.log("hello from timeout!"), 100);

//   const before = performance.now();
//   console.log("calling sleepSync");
//   const res = sleepSync(1500);
//   console.log(
//     "sleepSync returned",
//     performance.now() - before,
//     new Date().toISOString()
//   );

//   worker.terminate();
// })();

(async () => {
  const { Worker, BroadcastChannel } = require("node:worker_threads");
  console.log("root :: hello");

  // let i = 0;
  // let last = Date.now();
  // setInterval(() => {
  //   const now = Date.now();
  //   console.log(
  //     "root :: interval",
  //     i++,
  //     (now - last).toFixed(1),
  //     new Date().toISOString()
  //   );
  //   last = now;
  // }, 100);

  const waitForBoot = async (worker) => {
    await new Promise((resolve) =>
      worker.on("message", function handler(value) {
        if (value === "UP") {
          resolve();
          worker.off("message", handler);
        }
      })
    );
  };

  const waitForEnd = async (worker) => {
    await new Promise((resolve) =>
      worker.on("message", function handler(value) {
        if (value === "DONE") {
          resolve();
          worker.off("message", handler);
        }
      })
    );
  };

  const BUFFER_VALUE_NOT_DONE = 0;
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const asArray = new Int32Array(buffer);
  asArray[0] = BUFFER_VALUE_NOT_DONE;

  const channel = new MessageChannel();
  const mainWorker = new Worker(require.resolve("./main-worker"), {
    workerData: { channel: channel.port1, buffer: buffer },
    transferList: [channel.port1],
  });
  const cacheWorker = new Worker(require.resolve("./cache-worker"), {
    workerData: { channel: channel.port2, buffer: buffer },
    transferList: [channel.port2],
  });
  await Promise.all([waitForBoot(mainWorker), waitForBoot(cacheWorker)]);
  await waitForEnd(mainWorker);
  await Promise.all([mainWorker.terminate(), cacheWorker.terminate()]);
})();
