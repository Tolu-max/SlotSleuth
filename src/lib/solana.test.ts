import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareSnapshots,
  DEFAULT_ACCOUNT,
  inspectEndpoint,
  networkName,
  type EndpointSnapshot,
} from "./solana";

const MAINNET_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function respondJsonRpc(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === "/rate-limited") {
    response.writeHead(429, "Too Many Requests");
    response.end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (part: string) => { body += part; });
  request.on("end", () => {
    const respond = () => {
    const parsed: unknown = JSON.parse(body);
    const batch = Array.isArray(parsed);
    const requests = batch ? parsed : [parsed];
    const replies = requests.map((rpc: { id: number; method: string }) => {
      let result: unknown;
      switch (rpc.method) {
        case "getGenesisHash":
          result = MAINNET_HASH;
          break;
        case "getSlot":
          result = 345_678_901;
          break;
        case "getAccountInfo":
          result = {
            context: { slot: 345_678_899 },
            value: request.url === "/missing" ? null : {
              data: [Buffer.from("slotsleuth").toString("base64"), "base64"],
              executable: false,
              lamports: 23_000_000,
              owner: DEFAULT_ACCOUNT,
              rentEpoch: 0,
              space: 10,
            },
          };
          break;
        default:
          response.writeHead(400);
          response.end(JSON.stringify({ error: `Unexpected RPC method: ${rpc.method}` }));
          return null;
      }
      return { jsonrpc: "2.0", id: rpc.id, result };
    }).filter(Boolean);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(batch ? replies : replies[0]));
    };
    if (request.url === "/slow") setTimeout(respond, 150);
    else respond();
  });
}

function snapshot(overrides: Partial<EndpointSnapshot> = {}): EndpointSnapshot {
  return {
    genesisHash: MAINNET_HASH,
    networkName: "Mainnet Beta",
    finalizedSlot: 100,
    accountReadSlot: 99,
    exists: true,
    owner: DEFAULT_ACCOUNT,
    lamports: 10_000n,
    executable: false,
    dataLength: 4,
    dataSha256: "abc123",
    dataHashUnavailable: false,
    responseMs: 40,
    ...overrides,
  };
}

describe("SlotSleuth Solana inspection", () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer(respondJsonRpc);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test RPC failed to bind.");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("queries a JSON-RPC endpoint through the Solana SDK and decodes finalized account state", async () => {
    const result = await inspectEndpoint(endpoint, DEFAULT_ACCOUNT);

    expect(result.networkName).toBe("Mainnet Beta");
    expect(result.finalizedSlot).toBe(345_678_901);
    expect(result.accountReadSlot).toBe(345_678_899);
    expect(result.owner).toBe(DEFAULT_ACCOUNT);
    expect(result.lamports).toBe(23_000_000n);
    expect(result.dataLength).toBe(10);
    expect(result.dataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects malformed addresses before making an RPC request", async () => {
    await expect(inspectEndpoint(endpoint, "not-an-address"))
      .rejects.toThrow("valid Solana public address");
  });

  it("requires HTTPS except for a local validator", async () => {
    await expect(inspectEndpoint("http://example.com", DEFAULT_ACCOUNT))
      .rejects.toThrow("HTTPS RPC endpoint");
  });

  it("reports missing accounts as a valid empty state", async () => {
    const result = await inspectEndpoint(`${endpoint}/missing`, DEFAULT_ACCOUNT);
    expect(result.exists).toBe(false);
    expect(result.owner).toBeNull();
    expect(result.dataSha256).toBeNull();
  });

  it("keeps URL credentials out of displayed validation errors", async () => {
    await expect(inspectEndpoint("https://secret:private@example.invalid", DEFAULT_ACCOUNT))
      .rejects.toThrow("Remove embedded credentials");
  });

  it("turns HTTP rate limits into a useful provider error", async () => {
    await expect(inspectEndpoint(`${endpoint}/rate-limited`, DEFAULT_ACCOUNT))
      .rejects.toThrow("rate limited");
  });

  it("aborts slow RPC reads at the configured timeout", async () => {
    await expect(inspectEndpoint(`${endpoint}/slow`, DEFAULT_ACCOUNT, { timeoutMs: 10 }))
      .rejects.toThrow("timed out");
  });

  it("identifies standard Solana clusters and labels unrecognized fingerprints honestly", () => {
    expect(networkName(MAINNET_HASH)).toBe("Mainnet Beta");
    expect(networkName("unknown-hash")).toBe("Unknown cluster");
  });

  it("distinguishes agreement, state differences, and cross-cluster comparisons", () => {
    expect(compareSnapshots(snapshot(), snapshot()).accountState).toBe("match");
    expect(compareSnapshots(snapshot(), snapshot({ dataSha256: "different" })).differingFields)
      .toContain("account data hash");
    expect(compareSnapshots(snapshot(), snapshot({ lamports: 10_001n })).differingFields)
      .toContain("lamports");
    expect(compareSnapshots(snapshot(), snapshot({ genesisHash: "another-cluster" })).sameCluster)
      .toBe(false);
    expect(compareSnapshots(snapshot(), snapshot({ genesisHash: "another-cluster" })).slotDifference)
      .toBeNull();
  });
});
