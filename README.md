```
pnpm build
pnpm example:react-one-worker
```

The react code sits in [src/examples/fixtures/test-react.tsx](src/examples/fixtures/test-react.tsx)
The cache function implementations it uses are in [src/examples/fixtures/cache-functions.tsx](src/examples/fixtures/cache-functions.tsx)

### How this works

The setup of `react-one-worker` is like this. We've got

- the main thread: [src/examples/example-react-one-worker.ts](src/examples/example-react-one-worker.ts)
- a `Worker` that'll do the react rendering: [src/examples/workers/react-worker.tsx](src/examples/workers/react-worker.tsx)

You'll see things about a "server" and "client" in the code.
The client is the thread that needs to be blocked, and the server is the thread that'll actually execute the async work and then unblock the client. They're called that because we're sending messages back and forth and it kinda fits.

The basic flow is that when we want to block the client, we make it send a message to the server describing the work that needs to be performed (in this case, a function ID and the arguments) and then **block the whole worker thread using `Atomics.wait`** on a `SharedArrayBuffer` that the server thread shares with us. The server receives the message, performs the work, sends back a response message, and then wakes the client up using `Atomics.notify`. The client then checks for pending messages (which we can luckily do synchronously using `receiveMessageOnPort`) and continues on.

The above explanation is a bit simplified -- the actual implementation also does some batching of the requests to allow for more parallelism. And the whole point of this is the we need to prevent the current event loop task from ending, so the client has a poller loop that'll check for messages and block or yield to user code as appropriate (letting it resume at the point where it called the blocking function)

There's also some silly overcomplications around connecting multiple client Workers to a single server that runs in its own Worker, because a `MessagePort` can only be transferred once, so we need a separate `MessageChannel` for each client and do some weird messaging dounces around it. It can mostly be ignored.
