// Stabilised Launch Rider — a Sharpe-first paper bot for agent-fun/replay/v2.
//
// The edge, learned from the dev window: most pump.fun coins dump within slots
// of creation, and dip-buying them loses across every parameter cell (win rate
// ~30%, every stress window red). The only entries with positive expectancy are
// launches where the creator has real skin in the game AND several independent
// wallets pile in behind them in the first slots — genuine early demand, not a
// bundled dump. This bot buys those launches only, in a small fixed stake, and
// then rides them with a trailing stop: the money is in the right tail, so wins
// are capped only at +30% and losers are cut at −2.5% — a tight stop, because a
// launch that dips past 2.5% right after entry almost never comes back, while
// the 2–2.5% shakeout dip usually does. No banking, no pyramiding: one buy,
// then the trailing stop does the work. To keep hourly equity smooth for the
// Sharpe ranking the stakes stay small and fixed, so no single hour spikes.
//
// The stabilisation rule still applies: never buy the first cross — the entry
// needs the launch to prove follow-through (price holding above its creation
// level with buyers still arriving), not just one creator buy.
//
// Deterministic by construction: no clock, no randomness, no network, no I/O;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots after the CreateEvent during which a launch may be entered. */
  launchWindow: number;
  /** Creator must have bought at least this much SOL of their own coin. */
  creatorMinBuySol: number;
  /** Distinct non-creator buyers in the launch window. */
  minEarlyBuyers: number;
  /** Total buy SOL (creator + others) in the launch window. */
  minEarlyBuySol: number;
  /** Price now over creation price, minus 1 (follow-through, not a dump). */
  minPriceUp: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL staked in one position (single buy, no pyramid). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Bank half the position once value reaches cost * (1 + bankAt). */
  bankAt: number;
  /** Sell the whole position once value reaches cost * (1 + takeProfit). 0 = off. */
  takeProfit: number;
  /** Trailing stop: arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  trail: number;
  /** Hard stop loss, as a share of cost. */
  stopLoss: number;
  /** Exit when net SOL over flowWindow falls below -exitFlowSol. */
  flowWindow: number;
  exitFlowSol: number;
  /** Exit after this many slots held (only while the position is not up). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most launch positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: target coins / fills per paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  launchWindow: 3,
  creatorMinBuySol: 0.75,
  minEarlyBuyers: 3,
  minEarlyBuySol: 1,
  minPriceUp: 0.02,
  minRqSol: 1,
  maxRqSol: 80,
  stakeSol: 0.5,
  minBuySol: 0.012,
  buySlipBps: 1500,
  bankAt: 1000,
  takeProfit: 0.3,
  trailArm: 0.1,
  trail: 0.1,
  stopLoss: 0.025,
  flowWindow: 60,
  exitFlowSol: 0.5,
  maxHold: 1800,
  // 0.05: hold the winners past the time limit; losers still exit on the stop.
  holdIfUp: 0.05,
  cooldown: 300,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface TapeRec {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  /** SOL the creator bought of their own coin in the launch window. */
  creatorBuySol: number;
  /** SOL all wallets bought in the launch window. */
  earlyBuySol: number;
  /** Distinct non-creator buyers in the launch window. */
  earlyBuyers: Set<string>;
  /** Price at creation (first recorded trade). */
  createPrice: number;
  trades: TradeRec[];
  entries: number;
  lastExit: number;
}

interface HeldRec {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  /** Half the position already banked at bankAt. */
  banked: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, TapeRec>();
  const held = new Map<Pubkey, HeldRec>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.launchWindow, p.flowWindow) + 5;

  const tapeOf = (mint: Pubkey): TapeRec => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, creatorSold: false, creatorBuySol: 0, earlyBuySol: 0, earlyBuyers: new Set<string>(), createPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: TapeRec, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * Launch signal on a curve's tape at slot `now`: the launch is still inside
   * its window, the creator bought at least creatorMinBuySol of their own
   * coin, at least minEarlyBuyers independent wallets bought in behind them,
   * total early buy SOL clears minEarlyBuySol, the creator has not sold, and
   * the price holds at or above its creation level — follow-through, not a
   * dump. A launch with no skin in the game never qualifies.
   */
  const launchSignal = (t: TapeRec, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created > p.launchWindow) return false;
    if (t.creatorSold) return false;
    if (t.creatorBuySol < p.creatorMinBuySol) return false;
    if (t.earlyBuyers.size < p.minEarlyBuyers) return false;
    if (t.earlyBuySol < p.minEarlyBuySol) return false;
    if (t.createPrice <= 0) return false;
    if (price / t.createPrice - 1 < p.minPriceUp) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (t.createPrice === 0) t.createPrice = price;
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
          if (e.is_buy && t.created !== null && e.slot - t.created <= p.launchWindow) {
            t.earlyBuySol += sol;
            if (t.creator !== null && e.user === t.creator) t.creatorBuySol += sol;
            else t.earlyBuyers.add(e.user);
          }
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: bank half at bankAt, stop loss, trailing stop, creator sell, fade, time.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // Bank half once the position is up bankAt: smooths the hourly equity curve.
        if (!h.banked && value >= cost * (1 + p.bankAt) && !pendingByMint.has(mint) && orders.length < cap) {
          const half = BigInt(pos.token_amount) / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.banked = true;
          }
        }
        let exit = h.exiting;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && t.creatorSold) exit = true;
        if (!exit && flow(t, now, p.flowWindow) < -p.exitFlowSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one small fixed buy per qualifying launch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (!launchSignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, banked: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
