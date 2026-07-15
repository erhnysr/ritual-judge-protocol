# ritual-judge-protocol

A **chain-agnostic standard for requesting AI judging/scoring of content**, where
the inference runs on **Ritual Chain** (TEE-verified) and the result is consumed
by contracts on **Arc testnet** (chain `5042002`).

The trust improvement over "ask one model": every request is scored by **three
different registered Ritual TEE executors** with the **same** prompt, and the
**median** is taken. This removes single-model bias and is robust to one
outlier/faulty executor. The three Ritual transaction hashes are stored on-chain
so anyone can independently re-verify each TEE-attested inference on the Ritual
explorer.

```
Arc (5042002)              Ritual (1979)                  Arc (5042002)
requester contract         HermesRitualLLM (0x0802)       IAIJudgeCallback consumer
AIJudgeRequested  ──▶ ask() × 3 executors ──▶ median ──▶ onAIJudgeResult / submitScores
                            TEE-verified                  (3 ritual tx hashes stored)
```

## The standard

Two minimal interfaces make the protocol pluggable — any contract on any chain
conforms by emitting one event and (optionally) consuming one callback.

| Interface | Role | Shape |
|-----------|------|-------|
| [`IAIJudgeRequest`](src/interfaces/IAIJudgeRequest.sol) | a contract asks for a judgement | `event AIJudgeRequested(requestId, requester, contentHash, contentRef, criteria)` |
| [`IAIJudgeCallback`](src/interfaces/IAIJudgeCallback.sol) | a contract receives the result | `onAIJudgeResult(requestId, medianScore, bytes32[3] ritualTxHashes)` |

- `contentHash` is a stable identity/integrity commitment (e.g. `keccak256` of the
  resolved content). `contentRef` is the off-chain locator (IPFS/URL) the relayer
  resolves. They are separate so a request's identity doesn't depend on a mutable
  locator string.
- `ritualTxHashes[3]` are one Ritual tx per executor — the audit trail for the
  median.

## Consensus mechanism

[`MedianConsensus`](src/lib/MedianConsensus.sol) is a pure library:
`median = a + b + c − max − min`. Because the three raw scores are submitted
on-chain, the median is fully reproducible and **no one has to trust the relayer's
arithmetic** — only that the three scores correspond to the three published Ritual
tx hashes.

## Reference implementation — `AIJudgePanel` (Arc)

[`AIJudgePanel.sol`](src/AIJudgePanel.sol) implements **both** interfaces and is
the first integration target, for **Coliseum**:

- A relayer calls `openRequest(arena, submissionId, contentHash, contentRef, criteria)`
  → emits `AIJudgeRequested`.
- The relayer runs the 3-executor inference on Ritual, then calls
  `submitScores(requestId, uint256[3] scores, bytes32[3] ritualTxHashes)` — the
  panel computes the median **on-chain** and stores it. (`onAIJudgeResult` is also
  provided for relayers that only publish an off-chain median.)
- `scoreOf(arena, submissionId)` returns the AI score for any submission.

**It is completely read-only toward Coliseum.** It never calls, and requires no
change to, `Arena.sol` or `ArenaFactory.sol`; it only records `(arena, submissionId)`
so a score can be looked up. Any future contract reuses the protocol the same way.

## The relayer

[`relayer/`](relayer/) is a standalone TypeScript service (ethers v6). It:

1. reads Coliseum's `ArenaFactory.getArenas()` and watches each arena's
   `SubmissionCreated` events on Arc (backfill + live),
2. for each submission: opens a request on `AIJudgePanel`, resolves `contentRef`,
   and sends the same scoring prompt to **3 different** Ritual executors
   (discovered from `TEEServiceRegistry.getServicesByCapability(1, true)`),
3. writes the three scores + three Ritual tx hashes back to the panel.

```bash
cd relayer
cp .env.example .env   # fill in keys + AI_JUDGE_PANEL_ADDRESS
npm install
npm run typecheck
npm start
```

## Contracts: build, test, deploy

```bash
forge install foundry-rs/forge-std   # first time
forge build
forge test

# Deploy AIJudgePanel to Arc testnet
RELAYER_ADDRESS=0x... forge script script/DeployAIJudgePanel.s.sol \
  --rpc-url arc_testnet --broadcast
```

## Deployments & references

| Item | Chain | Address |
|------|-------|---------|
| HermesRitualLLM | Ritual testnet (1979) | [`0x076d193E55C526ae709c529EA952847eB3eb2441`](https://explorer.ritualfoundation.org/address/0x076d193E55C526ae709c529EA952847eB3eb2441) |
| TEEServiceRegistry | Ritual testnet (1979) | `0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F` |
| Coliseum ArenaFactory | Arc testnet (5042002) | `0x13a38e7C2bA5AFA76a1AC21Eaef9f4DEA293FEBe` |
| AIJudgePanel | Arc testnet (5042002) | [`0x36aAD394561b6b63c447b651F084116B7dA708d4`](https://testnet.arcscan.app/address/0x36aAD394561b6b63c447b651F084116B7dA708d4) |

### First two integrations

- **[Coliseum](https://github.com/erhnysr/coliseum)** — the judging market whose
  `SubmissionCreated` events this protocol scores (first consumer of `AIJudgePanel`).
- **[hermes-ritual-bridge](https://github.com/erhnysr/hermes-ritual-bridge)** — the
  `HermesRitualLLM` contract on Ritual that runs each TEE-verified inference. This
  protocol reuses its deployed instance; it is not re-deployed here.

## Layout

```
src/interfaces/IAIJudgeRequest.sol    the request standard (event)
src/interfaces/IAIJudgeCallback.sol   the result standard (callback)
src/lib/MedianConsensus.sol           median-of-3, trustless on-chain
src/AIJudgePanel.sol                  Arc reference implementation (Coliseum)
script/DeployAIJudgePanel.s.sol       deployment
test/AIJudgePanel.t.sol               unit + fuzz tests
relayer/src/relayer.ts                Arc ⇄ Ritual off-chain relayer
```

## License

MIT
