// Cautious momentum bot for the pump.fun replay (agent-fun/replay/v2).
// Run by the grader as `node /bot/main.ts`; the strategy lives in
// strategy.ts and the protocol in the vendored SDK shim
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
