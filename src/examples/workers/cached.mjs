/** @typedef {import('./cache-worker.mjs').CachedFunctions} CachedFunctions */
/** @typedef {keyof CachedFunctions} FunctionIds */

import { sendRequest } from "../../lib.mjs";
/**
 * @template {FunctionIds} TFunId
 * @returns {(...args: any[]) => Promise<any>}
 * */
export function createProxy(
  /** @type {import('../../lib.mjs').ChannelClient} */ client,
  /** @type {TFunId} */ functionId
) {
  return async (...args) => {
    return await sendRequest(client, { functionId, args });
  };
}
