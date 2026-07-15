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

async function main(): Promise<void> {
  const network = Network.from(RITUAL_CHAIN_ID);
  const provider = new JsonRpcProvider(RITUAL_RPC_URL, network, {
    staticNetwork: network,
  });
  const registry = new Contract(TEE_SERVICE_REGISTRY, REGISTRY_ABI, provider);

  console.log(`Ritual RPC:      ${RITUAL_RPC_URL}`);
  console.log(`TEEServiceRegistry: ${TEE_SERVICE_REGISTRY}\n`);

  const services: any[] = await registry.getServicesByCapability(CAPABILITY_LLM, true);
  const valid = services.filter((s) => s.isValid);
  const distinct = [...new Set(valid.map((s) => getAddress(s.node.teeAddress)))];

  console.log(
    `Reported services: ${services.length} | valid: ${valid.length} | distinct executors: ${distinct.length}\n`
  );

  for (const s of valid) {
    const addr = getAddress(s.node.teeAddress);
    const endpoint: string = s.node.endpoint;
    const health = await probe(endpoint);
    console.log(`• ${addr}`);
    console.log(`    endpoint: ${endpoint || "(none)"}`);
    console.log(`    health:   ${health}\n`);
  }

  console.log("── Summary ──");
  if (distinct.length >= EXECUTORS_PER_JUDGEMENT) {
    console.log(
      `✓ ${distinct.length} distinct executors — genuine ${EXECUTORS_PER_JUDGEMENT}-executor consensus is possible.`
    );
  } else if (distinct.length >= 1) {
    console.log(
      `⚠ Only ${distinct.length} distinct executor(s) — real consensus needs ` +
        `${EXECUTORS_PER_JUDGEMENT}. A degraded run is possible with ALLOW_EXECUTOR_REUSE=true ` +
        `(reachable endpoints don't guarantee inference actually succeeds).`
    );
  } else {
    console.log("✗ No valid LLM executors registered right now — judging can't run yet.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
