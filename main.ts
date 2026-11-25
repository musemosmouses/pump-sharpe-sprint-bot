// Entry point for the pump.fun Sharpe sprint bot.
//
// The harness speaks first: a hello line carrying the run's seed, the caps
// and the fees. After that comes one batch per slot — the slot's events plus
// the orders still in flight — and this bot answers each batch with exactly
// one reply holding the orders decided on that slot. The strategy itself
// lives in strategy.ts; this file only wires it to the replay shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

// One strategy, one run: the bot reads the replay on stdin and writes its
// replies to stdout until the harness sends done.
await runBot(createStrategy());
