import { address as solanaAddress, createSolanaRpc, isAddress } from "@solana/kit";

export const PUBLIC_MAINNET_RPC = "https://solana-rpc.publicnode.com";
export const DEFAULT_ACCOUNT = "11111111111111111111111111111111";
export const ACCOUNT_DATA_HASH_LIMIT = 10 * 1024 * 1024;

const CLUSTERS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "Mainnet Beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1: "Devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "Testnet",
};

export interface EndpointSnapshot {
  genesisHash: string;
  networkName: string;
  finalizedSlot: number;
  accountReadSlot: number;
  exists: boolean;
  owner: string | null;
  lamports: bigint | null;
  executable: boolean | null;
  dataLength: number | null;
  dataSha256: string | null;
  dataHashUnavailable: boolean;
  responseMs: number;
}

export class InspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionError";
  }
}

export interface EndpointComparison {
  sameCluster: boolean;
  accountState: "match" | "different" | "inconclusive";
  differingFields: string[];
  unverifiedFields: string[];
  slotDifference: number | null;
}

export type DiagnosticEndpoint =
  | { label: string; snapshot: EndpointSnapshot }
  | { label: string; error: string };

export function networkName(genesisHash: string): string {
  return CLUSTERS[genesisHash] ?? "Unknown cluster";
}

function validateEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new InspectionError("Enter a complete RPC URL, including https://.");
  }

  const localHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new InspectionError("Use an HTTPS RPC endpoint. HTTP is allowed only for localhost validators.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new InspectionError("Remove embedded credentials and URL fragments from the RPC URL.");
  }
}

function safeRpcMessage(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The RPC request timed out. Check the endpoint or try again.";
  }
  const context = error && typeof error === "object" && "context" in error
    ? (error as { context?: { statusCode?: unknown } }).context
    : undefined;
  if (context?.statusCode === 429) {
    return "This RPC endpoint is rate limited. Wait briefly or try another endpoint.";
  }
  if (context?.statusCode === 403 || context?.statusCode === 401) {
    return context.statusCode === 403
      ? "HTTP 403: this provider blocked the browser request. Use an endpoint that permits direct browser RPC access."
      : "HTTP 401: this RPC endpoint requires authentication. Check the provider's access requirements.";
  }
  if (typeof context?.statusCode === "number" && context.statusCode >= 500) {
    return "This RPC endpoint is temporarily unavailable. Retry or use another endpoint.";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "This RPC endpoint is rate limited. Wait briefly or try another endpoint.";
  }
  if (message.includes("403") || message.includes("401")) {
    return message.includes("403")
      ? "HTTP 403: this provider blocked the browser request. Use an endpoint that permits direct browser RPC access."
      : "HTTP 401: this RPC endpoint requires authentication. Check the provider's access requirements.";
  }
  if (/\b5\d\d\b/.test(message)) {
    return "This RPC endpoint is temporarily unavailable. Retry or use another endpoint.";
  }
  return "Could not read this RPC endpoint. Check its availability, browser CORS support, and network access.";
}

function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("context" in error) {
    const context = (error as { context?: { statusCode?: unknown } }).context;
    if (typeof context?.statusCode === "number") {
      return context.statusCode === 408 || context.statusCode === 425 || context.statusCode === 429 || context.statusCode >= 500;
    }
  }
  return error instanceof TypeError && !/abort|timeout/i.test(error.message);
}

async function retryDelay(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 250);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function withTransientRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientRpcError(error) || signal.aborted) throw error;
    await retryDelay(signal);
    return operation();
  }
}

async function hashAccountData(data: Uint8Array): Promise<string | null> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function inspectEndpoint(
  endpoint: string,
  address: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EndpointSnapshot> {
  validateEndpoint(endpoint.trim());

  if (!isAddress(address.trim())) {
    throw new InspectionError("Enter a valid Solana public address (32 bytes in base58).");
  }

  const timeoutMs = options.timeoutMs ?? 12_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals: AbortSignal[] = [timeoutSignal];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const rpc = createSolanaRpc(endpoint.trim());

  const startedAt = performance.now();
  try {
    const [genesisHash, finalizedSlot, accountResponse] = await Promise.all([
      withTransientRetry(() => rpc.getGenesisHash().send({ abortSignal: signal }), signal),
      withTransientRetry(() => rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: signal }), signal),
      withTransientRetry(() => rpc.getAccountInfo(solanaAddress(address.trim()), {
        commitment: "finalized",
        encoding: "base64",
      }).send({ abortSignal: signal }), signal),
    ]);
    const account = accountResponse.value;
    const dataLength = account ? Number(account.space) : null;
    const dataHashUnavailable = dataLength !== null && dataLength > ACCOUNT_DATA_HASH_LIMIT;
    const dataSha256 = account && !dataHashUnavailable
      ? await hashAccountData(decodeBase64(account.data[0]))
      : null;

    return {
      genesisHash,
      networkName: networkName(genesisHash),
      finalizedSlot: Number(finalizedSlot),
      accountReadSlot: Number(accountResponse.context.slot),
      exists: account !== null,
      owner: account?.owner ?? null,
      lamports: account?.lamports ?? null,
      executable: account?.executable ?? null,
      dataLength,
      dataSha256,
      dataHashUnavailable,
      responseMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new InspectionError("Comparison cancelled.");
    }
    if (timeoutSignal.aborted) {
      throw new InspectionError("The RPC request timed out. Check the endpoint or try again.");
    }
    throw new InspectionError(safeRpcMessage(error));
  }
}

export function compareSnapshots(
  left: EndpointSnapshot,
  right: EndpointSnapshot,
): EndpointComparison {
  const differingFields: string[] = [];
  const unverifiedFields: string[] = [];
  const sameCluster = left.genesisHash === right.genesisHash;

  if (!sameCluster) differingFields.push("cluster");
  if (left.exists !== right.exists) differingFields.push("account existence");

  if (left.exists && right.exists) {
    if (left.owner !== right.owner) differingFields.push("owner");
    if (left.executable !== right.executable) differingFields.push("executable flag");

    if (left.lamports !== right.lamports) differingFields.push("lamports");

    if (left.dataLength !== right.dataLength) differingFields.push("data length");
    if (left.dataHashUnavailable || right.dataHashUnavailable || !left.dataSha256 || !right.dataSha256) {
      unverifiedFields.push("account data hash");
    } else if (left.dataSha256 !== right.dataSha256) {
      differingFields.push("account data hash");
    }
  }

  const accountState = differingFields.length > 0
    ? "different"
    : unverifiedFields.length > 0
      ? "inconclusive"
      : "match";

  return {
    sameCluster,
    accountState,
    differingFields,
    unverifiedFields,
    slotDifference: sameCluster ? Math.abs(left.accountReadSlot - right.accountReadSlot) : null,
  };
}

export function formatSol(lamports: bigint): string {
  const whole = Number(lamports / 1_000_000_000n).toLocaleString("en-US");
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fraction || "0"} SOL`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export function serializeDiagnosticReport(
  address: string,
  endpoints: DiagnosticEndpoint[],
  comparison: EndpointComparison | null,
  generatedAt = new Date().toISOString(),
): string {
  const report = {
    schemaVersion: 1,
    product: "SlotSleuth",
    generatedAt,
    accountAddress: address,
    commitment: "finalized",
    observationModel: "Genesis, finalized slot, and account state are separate RPC reads. Endpoints are not compared at an atomic shared slot.",
    endpoints: endpoints.map((endpoint) => "snapshot" in endpoint
      ? {
        label: endpoint.label,
        status: "read" as const,
        snapshot: { ...endpoint.snapshot, lamports: endpoint.snapshot.lamports?.toString() ?? null },
      }
      : { label: endpoint.label, status: "unavailable" as const, error: endpoint.error }),
    comparison,
    privacy: "RPC endpoint URLs are intentionally omitted. The browser sent requests directly to the endpoints entered by the user.",
  };
  return JSON.stringify(report, null, 2);
}
