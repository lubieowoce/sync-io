import { ChannelClient, sendRequest } from "../../lib.js";
import type { CachedFunctionCall, CachedFunctions } from "./cache-worker.js";

export type FunctionIds = keyof CachedFunctions;

export function createProxy<TFunId extends FunctionIds>(
  client: ChannelClient,
  functionId: TFunId
): CachedFunctions[TFunId] {
  return async (...args: any[]) => {
    return (await sendRequest(client, {
      functionId,
      args,
    } satisfies CachedFunctionCall)) as Promise<any>;
  };
}
