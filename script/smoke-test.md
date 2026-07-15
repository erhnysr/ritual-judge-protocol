# AIJudgePanel end-to-end smoke test

A one-time, self-contained check of the full **Arc → Ritual → Arc** loop:
create a Coliseum arena, submit one real entry, and confirm the relayer opens a
request, runs the 3-executor median inference on Ritual, and writes the median +
three Ritual tx hashes back to `AIJudgePanel`.

The submission uses an **inline text `contentRef`** on purpose: the relayer's
`resolveContent` treats a non-`ipfs://` / non-`http(s)://` ref as the content
itself, so there is **no external IPFS/HTTP dependency** — the string is hashed
and judged directly. Deterministic and reproducible.

## Addresses (Arc testnet, chain 5042002)

| Item | Address |
|------|---------|
| ArenaFactory (Coliseum) | `0x13a38e7C2bA5AFA76a1AC21Eaef9f4DEA293FEBe` |
| ERC-20 USDC (6 dp, submission fee) | `0x3600000000000000000000000000000000000000` |
| AIJudgePanel | `0x36aAD394561b6b63c447b651F084116B7dA708d4` |
| Relayer EOA | `0x282981B15090B0CB84A545C4B754E54BcC2839ae` |

## Prerequisites

- `deployer` keystore holds the arena creator/submitter EOA
  (`0xD3467E00F6d7275C74e60fc7A1E5eD526893B29F`), with:
  - ≥ 0.10 ERC-20 USDC (6 dp) for the submission fee, plus a little gas USDC.
- Relayer EOA `0x2829…39ae` funded on **both** chains:
  - Arc: gas USDC (a few is plenty).
  - Ritual: ≥ ~1 RITUAL (each judgement = 3 executor calls; escrow ~0.31/in-flight,
    refunded after settlement). The relayer auto-deposits into RitualWallet on start.
- `relayer/.env` filled in, including `AI_JUDGE_PANEL_ADDRESS` and a `START_BLOCK`
  at or below the block where the test submission lands (so it isn't skipped).

> All `cast send` calls below unlock the `deployer` keystore and therefore need a
> real interactive terminal for the `Enter keystore password:` prompt — they will
> **not** work through a non-TTY wrapper.

## Steps

### 1. Create an arena (prize pool 0 → no USDC approval needed to create)

```bash
NOW=$(date +%s)
cast send 0x13a38e7C2bA5AFA76a1AC21Eaef9f4DEA293FEBe \
  "createArena(string,uint256,uint256,uint256)" \
  "AI judge smoke test" 0 $((NOW+3600)) $((NOW+7200)) \
  --account deployer --rpc-url https://rpc.testnet.arc.network
```

### 2. Read back the new arena address (last entry)

```bash
cast call 0x13a38e7C2bA5AFA76a1AC21Eaef9f4DEA293FEBe \
  "getArenas()(address[])" --rpc-url https://rpc.testnet.arc.network

ARENA=<paste_last_address>
```

### 3. Approve the 0.10 USDC submission fee to the arena

```bash
cast send 0x3600000000000000000000000000000000000000 \
  "approve(address,uint256)" $ARENA 100000 \
  --account deployer --rpc-url https://rpc.testnet.arc.network
```

### 4. Submit one real entry (inline content the AI scores)

```bash
cast send $ARENA "submit(string)" \
  "Arc makes five-cent votes viable: USDC as native gas, sub-cent fees, instant finality. Coliseum turns that into a judging market where both the crowd and a TEE-verified AI panel score every entry." \
  --account deployer --rpc-url https://rpc.testnet.arc.network
```

Emits `SubmissionCreated(0, deployer, contentRef)`.

### 5. Run the relayer

```bash
cd relayer && npm start
```

Expected log sequence:

```
● SubmissionCreated arena=<ARENA> id=0
▶ opened request #1 for <arena>:0 (open tx 0x…)
   executor 0x… -> <score> (ritual tx 0x…)
   executor 0x… -> <score> (ritual tx 0x…)
   executor 0x… -> <score> (ritual tx 0x…)
✓ request #1 judged: scores [a, b, c] median <m>
```

## Verify on-chain

```bash
PANEL=0x36aAD394561b6b63c447b651F084116B7dA708d4
ARC=https://rpc.testnet.arc.network

# median score + judged flag for the submission
cast call $PANEL "scoreOf(address,uint256)(bool,uint256,uint256)" $ARENA 0 --rpc-url $ARC

# the three raw executor scores (request id from scoreOf above)
cast call $PANEL "getScores(uint256)(uint256[3])" 1 --rpc-url $ARC

# the three Ritual tx hashes (independently checkable on the Ritual explorer)
cast call $PANEL "getRitualTxHashes(uint256)(bytes32[3])" 1 --rpc-url $ARC
```

`scoreOf` should return `(true, <median>, 1)`, and the median must equal the
middle of the three `getScores` values — the on-chain `MedianConsensus` result.

## Notes

- Idempotent: `openRequest` reverts `AlreadyRequested` for a submission that
  already has a request, and the relayer skips it via `scoreOf`. Re-running the
  relayer will not double-judge.
- Cost: one judgement spends 3 real Ritual inferences (RITUAL) plus two small Arc
  txs from the relayer (`openRequest` + `submitScores`) and the creator/submitter
  Arc txs above. All expected on testnet.
- The `"AI judge smoke test"` arena can be left as-is; there is no on-chain delete.
