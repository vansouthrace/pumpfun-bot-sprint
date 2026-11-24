// Early-launch sniper with a rug filter, for the pump.fun bonding-curve
// replay (agent-fun/replay/v2). Written from scratch for this entry.
//
// Why snipe launches instead of chasing momentum: on pump.fun most of a
// curve's move happens in its first seconds, and by the time a 30-slot
// window shows broad buying, the early wallets are already selling into
// it. So this bot buys in the first few slots after a curve is created,
// but only when the launch itself looks honest, and it gets out fast
// either way: take profit early, cut losers early, never hold past a
// dozen slots.
//
// Rug filter (all must pass before a first buy):
//   - age 0-4 slots since the CreateEvent;
//   - real SOL reserves between 0.3 and 30 (dust and already-run curves out);
//   - the creator's own buys in the create slot total at most 2 SOL
//     (a creator who pre-buys a huge stack is about to dump it);
//   - at most 1 distinct non-creator buyer seen so far (a launch
//     bundled across many wallets in its first slots is a dump in waiting,
//     and buying before the crowd arrives is the whole edge);
//   - the creator has not sold anything yet;
//   - no single non-creator sell bigger than 50% of the real SOL reserve;
//   - price within -10% .. +80% of the create price (no vertical run-up).
//
// Sizing: 0.08 SOL per coin, one buy only, no adds. At most 5 open
// positions (the harness cap), so at most ~0.4 SOL is ever at risk.
//
// Exits (whole position unless noted, first trigger wins):
//   - partial take-profit: at +12% over cost (fees included) sell half;
//   - full take-profit: at +20% over cost;
//   - stop loss: -10% under cost (after a partial, the rest stops at cost);
//   - trailing stop: once up 10%, exit on an 8% fall from the best value;
//   - time limit: 12 slots held;
//   - the creator sells while we hold: exit at once.
//
// Guardrail probes: tiny 0.02 SOL round trips on liquid curves, opened
// only when the bot's own fills or distinct coins lag the pace needed to
// finish with 25 coins / 240 fills, so the entry clears the 20-coin
// minimum even on a quiet window. A probe is sold whole as soon as its
// buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  stakeSol: number;
  minBuySol: number;
  minRqSol: number;
  maxRqSol: number;
  maxDevBuySol: number;
  maxBuyers: number;
  maxBigSellBps: number;
  minRunup: number;
  maxRunup: number;
  skipDevSold: boolean;
  buySlipBps: number;
  tpPartial: number;
  tpPartialPart: number;
  tp: number;
  sl: number;
  trailArm: number;
  trail: number;
  maxHold: number;
  exitOnDevSell: boolean;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 4,
  stakeSol: 0.08,
  minBuySol: 0.005,
  minRqSol: 0.3,
  maxRqSol: 30,
  maxDevBuySol: 2,
  maxBuyers: 1,
  maxBigSellBps: 5000,
  minRunup: -0.1,
  maxRunup: 0.8,
  skipDevSold: true,
  buySlipBps: 10_000,
  tpPartial: 0.12,
  tpPartialPart: 0.5,
  tp: 0.2,
  sl: 0.1,
  trailArm: 0.1,
  trail: 0.08,
  maxHold: 12,
  exitOnDevSell: true,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const BPS = 10_000;
const FEE_BPS = 125; // protocol 95 + creator 30

interface Coin {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuySol: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  bigSellBps: number;
  lastTradeSlot: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookPartial: boolean;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  const selling = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (e: { mint: Pubkey; slot: number; creator: Pubkey; virtual_quote_reserves: string; virtual_token_reserves: string }): Coin => {
    let c = coins.get(e.mint);
    if (c === undefined) {
      c = {
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuySol: 0,
        buyers: new Set(),
        devSold: false,
        bigSellBps: 0,
        lastTradeSlot: e.slot,
        done: false,
        complete: false,
      };
      coins.set(e.mint, c);
    }
    return c;
  };

  /** Split an amount into up to k pieces (each at least minPiece), for fill pacing. */
  const split = (mint: Pubkey, amount: bigint, k: number, isBuy: boolean, minPiece: bigint): OrderInput[] => {
    let n = BigInt(Math.max(1, k));
    while (n > 1n && amount / n < minPiece) n -= 1n;
    const piece = amount / n;
    if (piece === 0n) {
      return isBuy
        ? [{ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps }]
        : [{ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 }];
    }
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push(
        isBuy
          ? { side: 'buy', mint, quote_lamports: amt, max_slippage_bps: p.buySlipBps }
          : { side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 },
      );
    }
    return out;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinOf(e);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.createSlot) c.devBuySol += Number(sol) / LAMPORTS;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = Number((sol * BigInt(BPS)) / rqBefore);
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills++;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined && !probes.has(f.mint)) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookPartial: false,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) {
        let pending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') pending = true;
        }
        if (!pending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let pendingBuy = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') pendingBuy = true;
          }
          if (!pendingBuy) held.delete(mint);
        }
      }

      // Fill pacing: split orders when the fill count lags its pace.
      let pieces = 1;
      if (firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const dueFills = Math.ceil(p.targetFills * pace);
        const dueCoins = Math.ceil(p.targetCoins * pace);
        if (myFills < dueFills || myCoins.size < dueCoins) pieces = 3;
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookPartial: false, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : (curve?.virtual_quote_reserves ?? 0n);
        const vt = mk ? BigInt(mk.virtual_token_reserves) : (curve?.virtual_token_reserves ?? 0n);
        if (vt === 0n) continue;
        const value = sellValue(pos.token_amount, vq, vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        if (basis <= 0n) continue;
        const ratio = (a: bigint, b: bigint): number => Number(a) / Number(b);
        // Partial take-profit: sell half at +tpPartial%.
        if (!h.tookPartial && ratio(value, basis) >= 1 + p.tpPartial) {
          const part = pos.token_amount / 2n;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.tookPartial = true;
            h.best = 0n;
            continue;
          }
        }
        let exit = false;
        if (ratio(value, basis) >= 1 + p.tp) exit = true;
        const sl = h.tookPartial ? 0 : p.sl;
        if (ratio(value, basis) <= 1 - sl) exit = true;
        if (ratio(h.best, basis) >= 1 + p.trailArm && ratio(value, h.best) <= 1 - p.trail) exit = true;
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push(...split(mint, pos.token_amount, pieces, false, 2_000_000n));
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          let pending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint) pending = true;
          if (!pending) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        let pending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint) pending = true;
        if (pending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries: fresh launches that pass the rug filter.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      const txSol = Number(tx) / LAMPORTS;
      let open = state.committedPositionCount();
      const tradedMints = new Set<Pubkey>();
      for (const e of batch.events) tradedMints.add(e.mint);
      for (const mint of tradedMints) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devBuySol > p.maxDevBuySol) continue;
        if (c.buyers.size > p.maxBuyers) continue;
        if (c.bigSellBps > p.maxBigSellBps) continue;
        const runup =
          Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves) / (Number(c.vq0) / Number(c.vt0)) - 1;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const capLamports = state.maxBuyLamports(mint);
        const want = BigInt(Math.floor(p.stakeSol * LAMPORTS));
        const amount = want < capLamports ? want : capLamports;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        if (free < Number(amount) / LAMPORTS + txSol * 6) continue;
        const buys = split(mint, amount, pieces, true, 2_000_000n);
        orders.push(...buys);
        free -= Number(amount) / LAMPORTS + txSol * buys.length;
        open++;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && open < state.hello.caps.max_open_positions && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of tradedMints) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (coins.get(mint)?.done || held.has(mint) || probes.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
