/**
 * check-executors — quick liveness view of Ritual's LLM executor panel.
 *
 * Prints every executor the TEEServiceRegistry reports as valid for the LLM
 * capability, does a lightweight reachability probe of each serving endpoint,
 * and summarises whether the relayer can run genuine 3-executor consensus, a
 * degraded ALLOW_EXECUTOR_REUSE run, or nothing yet. Read-only; spends nothing.
 *
 *   npm run check-executors
 */
import "dotenv/config";
import { Contract, JsonRpcProvider, Network, getAddress } from "ethers";

const TEE_SERVICE_REGISTRY = "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F";
const CAPABILITY_LLM = 1;
const RITUAL_CHAIN_ID = 1979;
const EXECUTORS_PER_JUDGEMENT = 3;

const REGISTRY_ABI = [
  "function getServicesByCapability(uint8 capability, bool checkValidity) view returns (tuple(tuple(address paymentAddress, address teeAddress, uint8 teeType, bytes publicKey, string endpoint, bytes32 certPubKeyHash, uint8 capability) node, bool isValid, bytes32 workloadId)[])",
];

const RITUAL_RPC_URL = process.env.RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org";

/** GET the endpoint with a timeout; report reachable / status / error. */
async function probe(endpoint: string): Promise<string> {
  if (!endpoint || !/^https?:\/\//.test(endpoint)) return "no http endpoint";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(endpoint, { signal: ctrl.signal });
    return `reachable (HTTP ${res.status})`;
  } catch (err) {
    return `unreachable (${(err as Error).name})`;
  } finally {
    clearTimeout(t);
  }
}

type Readiness = "ready" | "degraded" | "none";

interface Snapshot {
  total: number;
  valid: number;
  distinctCount: number;
  executors: { addr: string; endpoint: string; health: string }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readiness(distinctCount: number): Readiness {
  if (distinctCount >= EXECUTORS_PER_JUDGEMENT) return "ready";
  if (distinctCount >= 1) return "degraded";
  return "none";
}

async function snapshot(registry: Contract): Promise<Snapshot> {
  const services: any[] = await registry.getServicesByCapability(CAPABILITY_LLM, true);
  const valid = services.filter((s) => s.isValid);
  const distinct = [...new Set(valid.map((s) => getAddress(s.node.teeAddress)))];
  const executors: Snapshot["executors"] = [];
  for (const s of valid) {
    const endpoint: string = s.node.endpoint;
    executors.push({
      addr: getAddress(s.node.teeAddress),
      endpoint,
      health: await probe(endpoint),
    });
  }
  return {
    total: services.length,
    valid: valid.length,
    distinctCount: distinct.length,
    executors,
  };
}

function printSummary(distinctCount: number): void {
  const r = readiness(distinctCount);
  if (r === "ready") {
    console.log(
      `✓ ${distinctCount} distinct executors — genuine ${EXECUTORS_PER_JUDGEMENT}-executor consensus is possible.`
    );
  } else if (r === "degraded") {
    console.log(
      `⚠ Only ${distinctCount} distinct executor(s) — real consensus needs ` +
        `${EXECUTORS_PER_JUDGEMENT}. A degraded run is possible with ALLOW_EXECUTOR_REUSE=true ` +
        `(reachable endpoints don't guarantee inference actually succeeds).`
    );
  } else {
    console.log("✗ No valid LLM executors registered right now — judging can't run yet.");
  }
}

function printFull(s: Snapshot): void {
  console.log(
    `Reported services: ${s.total} | valid: ${s.valid} | distinct executors: ${s.distinctCount}\n`
  );
  for (const e of s.executors) {
    console.log(`• ${e.addr}`);
    console.log(`    endpoint: ${e.endpoint || "(none)"}`);
    console.log(`    health:   ${e.health}\n`);
  }
  console.log("── Summary ──");
  printSummary(s.distinctCount);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch");
  const intervalArg = args.find((a) => a.startsWith("--interval="));
  const intervalSec = Math.max(5, intervalArg ? Number(intervalArg.split("=")[1]) : 30);

  const network = Network.from(RITUAL_CHAIN_ID);
  const provider = new JsonRpcProvider(RITUAL_RPC_URL, network, {
    staticNetwork: network,
  });
  const registry = new Contract(TEE_SERVICE_REGISTRY, REGISTRY_ABI, provider);

  console.log(`Ritual RPC:      ${RITUAL_RPC_URL}`);
  console.log(`TEEServiceRegistry: ${TEE_SERVICE_REGISTRY}\n`);

  if (!watch) {
    printFull(await snapshot(registry));
    return;
  }

  console.log(`Watching every ${intervalSec}s. Ctrl-C to stop.\n`);
  let prev: Readiness | null = null;
  for (;;) {
    const ts = new Date().toISOString().slice(11, 19);
    try {
      const s = await snapshot(registry);
      const r = readiness(s.distinctCount);
      const reachable = s.executors.filter((e) => e.health.startsWith("reachable")).length;
      const mark = r === "ready" ? "✓" : r === "degraded" ? "⚠" : "✗";
      console.log(
        `[${ts}] ${mark} valid=${s.valid} distinct=${s.distinctCount} reachable=${reachable}/${s.executors.length} [${r}]`
      );
      if (r !== prev) {
        if (r === "ready") {
          // terminal bell + banner on the transition that unblocks the loop
          console.log(
            `\x07\n🎉 ${EXECUTORS_PER_JUDGEMENT}+ distinct executors available — run \`npm start\` to close the loop.\n`
          );
        } else if (prev !== null) {
          console.log(`   (status changed: ${prev} → ${r})`);
        }
        prev = r;
      }
    } catch (err) {
      console.log(`[${ts}] ! query failed: ${(err as Error).message.slice(0, 80)}`);
    }
    await sleep(intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
