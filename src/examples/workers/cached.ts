import { ChannelClient, sendRequest } from "../../lib.js";
import type { CachedFunctions } from "./cache-worker.js";

export type FunctionIds = keyof CachedFunctions;

export function createProxy<TFunId extends FunctionIds>(
  client: ChannelClient,
  functionId: TFunId
): (...args: any[]) => Promise<any> {
  return async (...args) => {
    return await sendRequest(client, { functionId, args });
  };
}
