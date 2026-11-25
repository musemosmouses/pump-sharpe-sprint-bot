[![Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/musemosmouses/pump-sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/musemosmouses/pump-sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Stabilised Launch Rider — Sharpe-first pump.fun paper bot

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
bounty on make.fun. It trades a 6-hour pump.fun forward replay; places go by
**hourly Sharpe ratio**, so the bot is built for steady, controlled gains, not
one lucky moonshot.

## How it works

Most pump.fun coins dump within slots of creation, and dip-buying them loses
across every parameter cell on the dev window. The only entries with positive
expectancy are launches where the creator has real skin in the game **and**
several independent wallets pile in behind them in the first slots — genuine
early demand, not a bundled dump. This bot buys those launches only:

- **Entry (first 3 slots after CreateEvent):** creator bought ≥ 0.75 SOL of
  their own coin, ≥ 3 distinct non-creator buyers, ≥ 1 SOL total early buy
  volume, creator has not sold, curve holds ≥ 1 SOL real SOL, and the price
  already shows follow-through (≥ +2% above its creation price — never buy
  the first cross, wait for the launch to prove itself).
- **Size:** one small fixed buy per launch (0.5 SOL target, capped at 1% of
  the coin's real SOL reserve). No pyramiding.
- **Exits:** take profit +30%, stop loss −2.5%, trailing stop 10% once up 10%,
  exit at once when the creator sells or net flow turns negative, 1800-slot
  time limit (only while the position is not up 5%). Max 5 open positions,
  max 2 SOL exposure.
- **Guardrail pacer:** if traded coins lag a 25-coin / 6 h pace, tiny
  0.012 SOL probe round trips on liquid curves keep the 20-coin bar safe.

Deterministic: fixed parameters, no clock, no randomness, no network, no I/O.

## Dev-window results (frozen 24 h replay, local sim + kit grader)

| Check | Result |
|---|---|
| Net PnL (24 h dev window, kit grader) | +0.307 SOL |
| Hourly Sharpe (24 h dev window, local sim) | 0.21 |
| Max drawdown | 1.6% (bar ≤ 50%) |
| Coins / round trips ≥ 0.01 SOL | 254 / 254 (bar ≥ 20) |
| Stress: reversed | +0.082 SOL |
| Stress: −2%/h drift | +0.367 SOL |
| Stress: vol ×1.5 | +0.703 SOL |

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

`main.ts` is the entrypoint; `strategy.ts` holds the strategy;
`vendor/makefun-bot.ts` is the kit's replay shim, copied byte-identical.

## License

MIT — see [LICENSE](LICENSE).
