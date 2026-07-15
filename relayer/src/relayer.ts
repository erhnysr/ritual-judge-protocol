/**
 * ritual-judge-protocol relayer
 * ------------------------------
 * Bridges two chains, read-only toward Coliseum:
 *
 *   Arc (5042002)                 Ritual (1979)                 Arc (5042002)
 *   Coliseum Arena                HermesRitualLLM               AIJudgePanel
 *   SubmissionCreated ──▶ open ──▶ ask() x3 executors ──▶ median ──▶ submitScores()
 *
 * For every Coliseum submission it:
 *   1. opens a judge request on AIJudgePanel (emits IAIJudgeRequest),
 *   2. resolves the submission's contentRef and scores it with the SAME prompt
 *      against THREE different registered Ritual TEE executors (removes
 *      single-model bias),
 *   3. writes the three raw scores + three Ritual tx hashes back to the panel,
 *      which computes the median on-chain (IAIJudgeCallback).
 *
 * It never calls Arena.sol / ArenaFactory.sol to write — it only reads their
 * events and views, so Coliseum needs no modification to be judged.
 */
import "dotenv/config";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  keccak256,
  toUtf8Bytes,
  solidityPackedKeccak256,
  getAddress,
} from "ethers";

// ── Ritual system addresses (chain 1979), per hermes-ritual-bridge ──────────
const TEE_SERVICE_REGISTRY = "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F";
const RITUAL_WALLET = "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948";
const CAPABILITY_LLM = 1;
const EXECUTORS_PER_JUDGEMENT = 3; // the consensus panel size

// ── Minimal ABIs ────────────────────────────────────────────────────────────
const ARENA_FACTORY_ABI = [
  "function getArenas() view returns (address[])",
  "event ArenaCreated(address indexed arena, address indexed creator, string topic, uint256 prizePool, uint256 submissionDeadline, uint256 votingDeadline)",
];

const ARENA_ABI = [
  "function topic() view returns (string)",
  "event SubmissionCreated(uint256 indexed id, address indexed submitter, string contentRef)",
];

const PANEL_ABI = [
  "function openRequest(address arena, uint256 submissionId, bytes32 contentHash, string contentRef, string criteria) returns (uint256)",
  "function submitScores(uint256 requestId, uint256[3] scores, bytes32[3] ritualTxHashes)",
  "function scoreOf(address arena, uint256 submissionId) view returns (bool judged, uint256 medianScore, uint256 requestId)",
  "function requestIdOf(bytes32 key) view returns (uint256)",
  "event AIJudgeRequested(uint256 indexed requestId, address indexed requester, bytes32 contentHash, string contentRef, string criteria)",
];

const HERMES_ABI = [
  "function ask(address executor, string prompt) returns (uint256)",
  "function inferenceCount() view returns (uint256)",
  "function inferences(uint256) view returns (address requester, bool completed, bool hasError, string content, string finishReason, string errorMessage, bytes completionData)",
];

const REGISTRY_ABI = [
  "function getServicesByCapability(uint8 capability, bool checkValidity) view returns (tuple(tuple(address paymentAddress, address teeAddress, uint8 teeType, bytes publicKey, string endpoint, bytes32 certPubKeyHash, uint8 capability) node, bool isValid, bytes32 workloadId)[])",
];

const WALLET_ABI = [
  "function deposit(uint256 lockDuration) payable",
  "function balanceOf(address user) view returns (uint256)",
];

// ── Env ──────────────────────────────────────────────────────────────────────
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const ARC_RPC_URL = reqEnv("ARC_RPC_URL");
const ARC_PRIVATE_KEY = reqEnv("ARC_PRIVATE_KEY");
const ARENA_FACTORY_ADDRESS = getAddress(reqEnv("ARENA_FACTORY_ADDRESS"));
const AI_JUDGE_PANEL_ADDRESS = getAddress(reqEnv("AI_JUDGE_PANEL_ADDRESS"));
const START_BLOCK = Number(process.env.START_BLOCK ?? "0");

const RITUAL_RPC_URL = reqEnv("RITUAL_RPC_URL");
const RITUAL_PRIVATE_KEY = reqEnv("RITUAL_PRIVATE_KEY");
const HERMES_RITUAL_LLM_ADDRESS = getAddress(reqEnv("HERMES_RITUAL_LLM_ADDRESS"));
const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";

// ── Providers / signers ───────────────────────────────────────────────────────
const ARC_CHAIN_ID = 5042002;
const RITUAL_CHAIN_ID = 1979;

// `staticNetwork` pins the chain id so ethers NEVER calls `eth_chainId` — that
// handshake call is what was 429-ing on boot against the single shared public
// Arc RPC. A wider `pollingInterval` also cuts the event-poll request rate.
function makeProvider(url: string, chainId: number): JsonRpcProvider {
  const network = Network.from(chainId);
  const provider = new JsonRpcProvider(url, network, { staticNetwork: network });
  provider.pollingInterval = 8000;
  return provider;
}

const arc = makeProvider(ARC_RPC_URL, ARC_CHAIN_ID);
const arcSigner = new Wallet(ARC_PRIVATE_KEY, arc);
const ritual = makeProvider(RITUAL_RPC_URL, RITUAL_CHAIN_ID);
const ritualSigner = new Wallet(RITUAL_PRIVATE_KEY, ritual);

const factory = new Contract(ARENA_FACTORY_ADDRESS, ARENA_FACTORY_ABI, arc);
const panel = new Contract(AI_JUDGE_PANEL_ADDRESS, PANEL_ABI, arcSigner);
const hermes = new Contract(HERMES_RITUAL_LLM_ADDRESS, HERMES_ABI, ritualSigner);
const registry = new Contract(TEE_SERVICE_REGISTRY, REGISTRY_ABI, ritual);
const ritualWallet = new Contract(RITUAL_WALLET, WALLET_ABI, ritualSigner);

// ── Retry / backoff ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Flatten an error (incl. ethers' nested `.info` / `.error`) into one searchable
// string so we can match the rate-limit code/message wherever it's buried.
function errText(err: unknown): string {
  const e = err as any;
  const parts = [
    e?.message,
    e?.code,
    e?.shortMessage,
    e?.info ? JSON.stringify(e.info) : "",
    e?.error ? JSON.stringify(e.error) : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// Transient RPC failures worth retrying. Arc's public RPC returns JSON-RPC
// code -32011 ("request limit reached") under load; ethers surfaces it as an
// UNKNOWN_ERROR / "could not coalesce" wrapper, so match both the code and text.
const RETRYABLE =
  /-32011|429|request limit|rate limit|limit reached|too many requests|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|SERVER_ERROR|UNKNOWN_ERROR|bad response|could not coalesce|failed to detect network/i;

/**
 * Retry a network READ with exponential backoff (2s → 30s cap, 8 attempts).
 * Only wrap idempotent reads / getLogs / connectivity checks — never a tx send
 * (a retried `ask()` would run and pay for a second inference). Non-retryable
 * errors propagate immediately.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 8
): Promise<T> {
  let delay = 2000;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = errText(err);
      if (i === attempts || !RETRYABLE.test(msg)) throw err;
      console.warn(
        `… ${label} failed (attempt ${i}/${attempts}): ${msg.slice(0, 100)} — retrying in ${delay}ms`
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
  throw new Error("unreachable");
}

// ── Content resolution ────────────────────────────────────────────────────────

/** Resolve a Coliseum contentRef (ipfs:// or http[s]://) to its raw text. */
async function resolveContent(contentRef: string): Promise<string> {
  let url = contentRef;
  if (contentRef.startsWith("ipfs://")) {
    url = IPFS_GATEWAY + contentRef.slice("ipfs://".length);
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return await res.text();
  }
  // Not a locator we can resolve — treat the ref itself as the content (e.g. a
  // raw inline string). Callers still get a stable contentHash over these bytes.
  return contentRef;
}

// ── Ritual: three-executor median inference ───────────────────────────────────

/** Discover >= EXECUTORS_PER_JUDGEMENT distinct, valid LLM executors. */
async function discoverExecutors(): Promise<string[]> {
  const override = process.env.EXECUTOR_ADDRESSES;
  if (override && override.trim().length > 0) {
    const addrs = override.split(",").map((a) => getAddress(a.trim()));
    const distinct = [...new Set(addrs)];
    if (distinct.length < EXECUTORS_PER_JUDGEMENT) {
      throw new Error(
        `EXECUTOR_ADDRESSES needs >= ${EXECUTORS_PER_JUDGEMENT} distinct addresses`
      );
    }
    return distinct.slice(0, EXECUTORS_PER_JUDGEMENT);
  }

  const services: any[] = await withRetry("registry.getServicesByCapability", () =>
    registry.getServicesByCapability(CAPABILITY_LLM, true)
  );
  const distinct = [
    ...new Set(
      services.filter((s) => s.isValid).map((s) => getAddress(s.node.teeAddress))
    ),
  ];
  if (distinct.length < EXECUTORS_PER_JUDGEMENT) {
    throw new Error(
      `Only ${distinct.length} valid LLM executor(s) registered; the median ` +
        `consensus needs ${EXECUTORS_PER_JUDGEMENT} distinct ones. Set ` +
        `EXECUTOR_ADDRESSES or retry later.`
    );
  }
  return distinct.slice(0, EXECUTORS_PER_JUDGEMENT);
}

/** Build the scoring prompt. Model must answer with a single integer 0..100. */
function buildPrompt(criteria: string, content: string): string {
  return (
    `You are an impartial judge. Score the SUBMISSION from 0 to 100 against the ` +
    `CRITERIA. Reply with ONLY the integer score, no words, no punctuation.\n\n` +
    `CRITERIA:\n${criteria}\n\nSUBMISSION:\n${content}`
  );
}

/** Extract a 0..100 integer from a model reply; throws if none found. */
function parseScore(reply: string): number {
  const m = reply.match(/\d{1,3}/);
  if (!m) throw new Error(`no numeric score in reply: ${JSON.stringify(reply)}`);
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad score: ${m[0]}`);
  return Math.min(100, n);
}

/** Ensure the Ritual signer has fee balance for the async LLM escrow. */
async function ensureRitualFees(): Promise<void> {
  const bal: bigint = await withRetry("ritualWallet.balanceOf", () =>
    ritualWallet.balanceOf(ritualSigner.address)
  );
  const floor = 400_000_000_000_000_000n; // 0.4 RITUAL
  if (bal < floor) {
    const topUp = 500_000_000_000_000_000n; // 0.5 RITUAL
    console.log(`Funding RitualWallet with 0.5 RITUAL (balance ${bal})...`);
    const tx = await ritualWallet.deposit(100_000n, { value: topUp });
    await tx.wait();
  }
}

/** Run one inference on a specific executor; return { score, ritualTxHash }. */
async function judgeOnce(
  executor: string,
  prompt: string
): Promise<{ score: number; ritualTxHash: string }> {
  const tx = await hermes.ask(executor, prompt, { gasLimit: 5_000_000n });
  const receipt = await tx.wait();

  // Short-running async settles into the same tx, so the result is already
  // persisted. The latest inference id is inferenceCount - 1.
  const count: bigint = await withRetry("hermes.inferenceCount", () =>
    hermes.inferenceCount()
  );
  const inf = await withRetry("hermes.inferences", () => hermes.inferences(count - 1n));
  if (inf.hasError) {
    throw new Error(`executor ${executor} inference error: ${inf.errorMessage}`);
  }
  return { score: parseScore(inf.content), ritualTxHash: receipt.hash };
}

// ── Core: judge one submission end-to-end ─────────────────────────────────────

/**
 * Send a GUARDED, idempotent tx with retry. Only safe for `openRequest` /
 * `submitScores`: the panel reverts (`AlreadyRequested` / `NotAwaitingJudgement`)
 * on a true double, which we treat as "already applied" success. NEVER use this
 * for `ask()` — a retried inference would run and pay twice.
 */
async function sendGuarded(
  label: string,
  send: () => Promise<any>,
  alreadyDone: RegExp
): Promise<void> {
  await withRetry(label, async () => {
    try {
      const tx = await send();
      await tx.wait();
    } catch (err) {
      if (alreadyDone.test(errText(err))) {
        console.log(`   ${label}: already applied on-chain, continuing`);
        return;
      }
      throw err;
    }
  });
}

/**
 * Judge one submission. Resumable and idempotent: safe to call repeatedly for
 * the same submission across poll ticks. Returns true once the submission is
 * judged on-chain (so the caller can drop it from the pending queue), false if
 * this attempt failed and should be retried.
 */
async function judgeSubmission(
  arenaAddr: string,
  submissionId: bigint,
  contentRef: string
): Promise<boolean> {
  const key = `${arenaAddr.toLowerCase()}:${submissionId}`;
  try {
    const [judged, , existing] = await withRetry("panel.scoreOf", () =>
      panel.scoreOf(arenaAddr, submissionId)
    );
    if (judged) return true; // nothing to do

    const arena = new Contract(arenaAddr, ARENA_ABI, arc);
    const topic: string = await withRetry("arena.topic", () => arena.topic());
    const criteria =
      `Judge this entry for the contest topic: "${topic}". ` +
      `Reward relevance, quality, originality and wit.`;

    const content = await resolveContent(contentRef);
    const contentHash = keccak256(toUtf8Bytes(content));

    // 1) open the request (or resume an already-open, unjudged one)
    let requestId = existing;
    if (requestId === 0n) {
      await sendGuarded(
        "openRequest",
        () => panel.openRequest(arenaAddr, submissionId, contentHash, contentRef, criteria),
        /AlreadyRequested/
      );
      requestId = await withRetry("panel.requestIdOf", () =>
        panel.requestIdOf(
          solidityPackedKeccak256(["address", "uint256"], [arenaAddr, submissionId])
        )
      );
      console.log(`▶ opened request #${requestId} for ${key}`);
    } else {
      console.log(`↻ resuming unjudged request #${requestId} for ${key}`);
    }

    // 2) three-executor inference on Ritual. `ask()` is NOT retried (non-
    //    idempotent); if it fails, we return false and re-run on the next tick.
    await ensureRitualFees();
    const executors = await discoverExecutors();
    const prompt = buildPrompt(criteria, content);

    const scores: number[] = [];
    const ritualTxHashes: string[] = [];
    for (const executor of executors) {
      const { score, ritualTxHash } = await judgeOnce(executor, prompt);
      console.log(`   executor ${executor} -> ${score} (ritual tx ${ritualTxHash})`);
      scores.push(score);
      ritualTxHashes.push(ritualTxHash);
    }

    // 3) write back; panel computes the median on-chain
    await sendGuarded(
      "submitScores",
      () =>
        panel.submitScores(
          requestId,
          scores as [number, number, number],
          ritualTxHashes as [string, string, string]
        ),
      /NotAwaitingJudgement/
    );
    const [, median] = await withRetry("panel.scoreOf", () =>
      panel.scoreOf(arenaAddr, submissionId)
    );
    console.log(
      `✓ request #${requestId} judged: scores [${scores.join(", ")}] median ${median}`
    );
    return true;
  } catch (err) {
    console.error(`✗ ${key} failed: ${errText(err).slice(0, 160)}`);
    return false; // keep it queued; retried on the next tick
  }
}

// ── Watching Coliseum (single-poll, rate-limit friendly) ──────────────────────
//
// We deliberately do NOT use ethers `contract.on(...)` subscriptions: each one
// starts its own background `eth_getLogs` poller that is outside `withRetry`, so
// under Arc's public-RPC rate limiting they emit an unhandled provider `error`
// event and crash the process. Instead we run one owned loop that:
//   - batches ALL known arenas into a SINGLE eth_getLogs per tick (address array),
//     so request volume is constant regardless of arena count, and
//   - wraps every getLogs / getBlockNumber in withRetry.

const POLL_INTERVAL_MS = 8000;

const arenaIface = new Interface(ARENA_ABI);
const factoryIface = new Interface(ARENA_FACTORY_ABI);
const SUBMISSION_TOPIC = arenaIface.getEvent("SubmissionCreated")!.topicHash;
const ARENA_CREATED_TOPIC = factoryIface.getEvent("ArenaCreated")!.topicHash;

interface PendingSub {
  arena: string;
  id: bigint;
  contentRef: string;
}

async function watchLoop(): Promise<void> {
  const knownArenas = new Set<string>(); // checksummed addresses
  // Discovered-but-not-yet-judged submissions. Discovery advances `fromBlock`
  // once, but judging is retried from here every tick until it lands on-chain,
  // so a submission is never lost to a transient failure.
  const pending = new Map<string, PendingSub>();

  // Seed with arenas that already exist.
  const seed: string[] = await withRetry("factory.getArenas", () => factory.getArenas());
  for (const a of seed) knownArenas.add(getAddress(a));
  console.log(`Seeded ${knownArenas.size} existing arena(s).`);

  // Never scan a giant historical range in one getLogs. If START_BLOCK is 0
  // (unset), start from the current head instead of block 0.
  const head = await withRetry("boot: arc.getBlockNumber", () => arc.getBlockNumber());
  let fromBlock = START_BLOCK > 0 ? START_BLOCK : head;
  console.log(`Watching from block ${fromBlock}. Ctrl-C to stop.\n`);

  for (;;) {
    // ── Discovery: advance fromBlock, enqueue any new submissions ──
    try {
      const current = await withRetry("arc.getBlockNumber", () => arc.getBlockNumber());
      if (current >= fromBlock) {
        // 1) new arenas created since last tick
        const createdLogs = await withRetry("getLogs:ArenaCreated", () =>
          arc.getLogs({
            address: ARENA_FACTORY_ADDRESS,
            topics: [ARENA_CREATED_TOPIC],
            fromBlock,
            toBlock: current,
          })
        );
        for (const log of createdLogs) {
          const addr = getAddress(factoryIface.parseLog(log)!.args.arena as string);
          if (!knownArenas.has(addr)) {
            knownArenas.add(addr);
            console.log(`● ArenaCreated ${addr}`);
          }
        }

        // 2) one getLogs for SubmissionCreated across ALL known arenas
        if (knownArenas.size > 0) {
          const subLogs = await withRetry("getLogs:SubmissionCreated", () =>
            arc.getLogs({
              address: [...knownArenas],
              topics: [SUBMISSION_TOPIC],
              fromBlock,
              toBlock: current,
            })
          );
          for (const log of subLogs) {
            const parsed = arenaIface.parseLog(log)!;
            const arena = getAddress(log.address);
            const id = parsed.args.id as bigint;
            const k = `${arena.toLowerCase()}:${id}`;
            if (!pending.has(k)) {
              pending.set(k, { arena, id, contentRef: parsed.args.contentRef as string });
              console.log(`● SubmissionCreated arena=${arena} id=${id}`);
            }
          }
        }

        fromBlock = current + 1;
      }
    } catch (err) {
      // Discovery failed this tick; fromBlock not advanced, so nothing skipped.
      console.error(`watch tick (discovery) failed: ${errText(err).slice(0, 160)}`);
    }

    // ── Judging: drain the pending queue; keep failures for the next tick ──
    for (const [k, sub] of [...pending]) {
      const done = await judgeSubmission(sub.arena, sub.id, sub.contentRef);
      if (done) pending.delete(k);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  console.log(`Relayer: ${arcSigner.address} (Arc) / ${ritualSigner.address} (Ritual)`);
  console.log(`Panel:   ${AI_JUDGE_PANEL_ADDRESS}`);
  console.log(`Factory: ${ARENA_FACTORY_ADDRESS}\n`);

  // Safety net: swallow stray provider errors so a transient background failure
  // can never crash the process via an unhandled 'error' event.
  arc.on("error", (e) => console.warn(`arc provider: ${errText(e).slice(0, 100)}`));
  ritual.on("error", (e) => console.warn(`ritual provider: ${errText(e).slice(0, 100)}`));

  const block = await withRetry("boot: arc.getBlockNumber", () => arc.getBlockNumber());
  console.log(`Connected to Arc at block ${block}.\n`);

  await watchLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
