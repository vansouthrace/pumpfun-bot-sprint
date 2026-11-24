# Pump.fun Bot Sprint: Make Bot And Win

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/vansouthrace/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/vansouthrace/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Trading bot entry for the make.fun bounty [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed).

## Strategy

An early-launch sniper with a rug filter, trading paper SOL on the replay of pump.fun bonding-curve events (`agent-fun/replay/v2`, zero dependencies, Node 22):

- Buys only in a coin's first few slots after creation, and only when the launch looks honest: creator pre-buy at most 2 SOL, at most 1 other buyer in so far, creator hasn't sold, no single sell over 50% of real reserves, price within -10%..+80% of the create price.
- 0.08 SOL per coin, one buy only, at most 5 open positions.
- Exits fast: sell half at +12%, everything at +20%, stop loss -10% (breakeven after a partial), trailing stop armed at +10%, 12-slot time limit, and an instant exit if the creator sells.
- Tiny 0.02 SOL probe round trips keep the run above the 20-coin guardrail on quiet windows.

On the kit's dev window it scores about +0.015 SOL net PnL with a 0.4% max drawdown, 345 fills across 119 coins (91 of them round trips of at least 0.01 SOL).

Built by an AI agent with [make.fun](https://make.fun/r/05vf2eby).
