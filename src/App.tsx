import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAddress } from "@solana/kit";
import {
  compareSnapshots,
  DEFAULT_ACCOUNT,
  inspectEndpoint,
  InspectionError,
  PUBLIC_MAINNET_RPC,
  serializeDiagnosticReport,
  shortHash,
  formatSol,
  type EndpointComparison,
  type EndpointSnapshot,
} from "./lib/solana";

type EndpointOutcome =
  | { ok: true; value: EndpointSnapshot }
  | { ok: false; error: string };

interface ComparisonRun {
  left: EndpointOutcome;
  right: EndpointOutcome | null;
  comparison: EndpointComparison | null;
  address: string;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function downloadReport(run: ComparisonRun): void {
  const endpoints = [
    run.left.ok
      ? { label: "Endpoint A", snapshot: run.left.value }
      : { label: "Endpoint A", error: run.left.error },
  ];
  if (run.right) endpoints.push(run.right.ok
    ? { label: "Endpoint B", snapshot: run.right.value }
    : { label: "Endpoint B", error: run.right.error });
  const report = serializeDiagnosticReport(run.address, endpoints, run.comparison);
  const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `slotsleuth-${run.address.slice(0, 8)}-report.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function validateAddress(address: string): string | null {
  if (!address.trim()) return "Enter an account address to inspect.";
  return isAddress(address.trim()) ? null : "Enter a valid Solana public address.";
}

async function readEndpoint(endpoint: string, address: string, signal: AbortSignal): Promise<EndpointOutcome> {
  try {
    return { ok: true, value: await inspectEndpoint(endpoint, address, { signal }) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof InspectionError ? error.message : "Could not inspect this RPC endpoint.",
    };
  }
}

function EndpointCard({ label, outcome }: { label: string; outcome: EndpointOutcome }) {
  if (!outcome.ok) {
    return (
      <section className="result-card result-card--error" aria-label={`${label} result`}>
        <div className="result-card__top">
          <div className="endpoint-title"><span className="endpoint-index">{label === "Endpoint A" ? "01" : "02"}</span><h3>{label}</h3></div>
          <span className="status-tag status-tag--error"><span className="status-dot" />Unavailable</span>
        </div>
        <div className="endpoint-error" role="status">{outcome.error}</div>
      </section>
    );
  }

  const result = outcome.value;
  return (
    <section className="result-card" aria-label={`${label} result`}>
      <div className="result-card__top">
        <div className="endpoint-title"><span className="endpoint-index">{label === "Endpoint A" ? "01" : "02"}</span><h3>{label}</h3></div>
        <span className="status-tag"><span className="status-dot" />Response received</span>
      </div>
      <div className="network-line">
        <span className="network-label">{result.networkName}</span>
        <span className="latency"><span className="latency-mark" />{Math.round(result.responseMs)} ms</span>
      </div>
      <div className="metric-row">
        <div className="metric"><span>Finalized slot</span><strong>{formatInteger(result.finalizedSlot)}</strong></div>
        <div className="metric"><span>Account read slot</span><strong>{formatInteger(result.accountReadSlot)}</strong></div>
      </div>
      <div className="account-panel">
        <div className="account-panel__heading"><span>ACCOUNT STATE</span>{result.exists ? <b className="exists">FOUND</b> : <b className="missing">NOT FOUND</b>}</div>
        {result.exists ? (
          <>
            <div className="account-facts">
              <div><span>Owner</span><code title={result.owner ?? "Unknown"}>{result.owner ? `${result.owner.slice(0, 9)}…${result.owner.slice(-7)}` : "Unknown"}</code></div>
              <div><span>Balance</span><code>{result.lamports === null ? "—" : formatSol(result.lamports)}</code></div>
              <div><span>Data size</span><code>{result.dataLength === null ? "—" : `${formatInteger(result.dataLength)} bytes`}</code></div>
              <div><span>Executable</span><code>{result.executable ? "Yes" : "No"}</code></div>
            </div>
            <div className="hash-line">
              <span>Account data SHA-256</span>
              <code title={result.dataSha256 ?? undefined}>
                {result.dataSha256 ? shortHash(result.dataSha256) : result.dataHashUnavailable ? "Account exceeds 10 MiB hashing limit" : "No account data"}
              </code>
            </div>
          </>
        ) : <p className="empty-account">No account exists at this address at the finalized commitment.</p>}
      </div>
      <div className="fingerprint"><span>Genesis fingerprint</span><code title={result.genesisHash}>{shortHash(result.genesisHash)}</code></div>
    </section>
  );
}

function ComparisonSummary({ run }: { run: ComparisonRun }) {
  if (!run.comparison) return null;
  const comparison = run.comparison;
  const variant = !comparison.sameCluster ? "warning" : comparison.accountState;
  const heading = !comparison.sameCluster
    ? "Different Solana clusters"
    : comparison.accountState === "match"
        ? "Observed account fields match"
      : comparison.accountState === "different"
        ? "Observed account fields differ"
        : "Comparison is inconclusive";
  const explanation = !comparison.sameCluster
    ? "These RPCs returned different genesis hashes. Their account responses come from different clusters."
    : comparison.accountState === "match"
      ? "Both endpoints returned the same finalized account fields and data hash in separate reads."
      : comparison.accountState === "different"
        ? `The responses differ in ${comparison.differingFields.join(", ")}. A state change may land between reads.`
        : `The responses agree on comparable fields, but ${comparison.unverifiedFields.join(", ")} could not be compared exactly.`;

  return (
    <section className={`comparison-summary comparison-summary--${variant}`} aria-live="polite">
      <div className="comparison-symbol" aria-hidden="true">{variant === "match" ? "✓" : variant === "warning" ? "!" : "≠"}</div>
      <div className="comparison-copy"><span className="eyebrow">TWO-ENDPOINT OBSERVATION</span><h2>{heading}</h2><p>{explanation}</p>
        <p className="comparison-context">{comparison.slotDifference === null
          ? "Slot heights belong to different clusters and cannot be compared directly."
          : `Account reads were ${formatInteger(comparison.slotDifference)} slot${comparison.slotDifference === 1 ? "" : "s"} apart. State can advance between RPC requests, so a difference is a diagnostic signal, not proof of a faulty provider.`}</p>
      </div>
      <div className="comparison-stamp"><span>CLUSTER</span><strong>{comparison.sameCluster ? "SAME" : "DIFFERENT"}</strong></div>
    </section>
  );
}

function App() {
  const [address, setAddress] = useState(DEFAULT_ACCOUNT);
  const [endpointA, setEndpointA] = useState(PUBLIC_MAINNET_RPC);
  const [endpointB, setEndpointB] = useState("");
  const [showA, setShowA] = useState(false);
  const [showB, setShowB] = useState(false);
  const [run, setRun] = useState<ComparisonRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const runNumber = useRef(0);

  useEffect(() => () => controller.current?.abort(), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    setRun(null);

    const addressError = validateAddress(address);
    if (addressError) {
      setFormError(addressError);
      return;
    }
    if (!endpointA.trim()) {
      setFormError("Enter an RPC URL to inspect account state.");
      return;
    }
    if (endpointB.trim()) {
      try {
        const normalizedA = new URL(endpointA.trim()).href.replace(/\/$/, "");
        const normalizedB = new URL(endpointB.trim()).href.replace(/\/$/, "");
        if (normalizedA === normalizedB) {
          setFormError("Use two different RPC URLs for a meaningful comparison.");
          return;
        }
      } catch {
        // Detailed URL errors are reported per endpoint below, without echoing its contents.
      }
    }

    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    const activeRun = ++runNumber.current;
    setBusy(true);

    const [left, right] = await Promise.all([
      readEndpoint(endpointA.trim(), address.trim(), activeController.signal),
      endpointB.trim()
        ? readEndpoint(endpointB.trim(), address.trim(), activeController.signal)
        : Promise.resolve(null),
    ]);

    if (activeRun === runNumber.current) {
      const comparison = left.ok && right?.ok ? compareSnapshots(left.value, right.value) : null;
      setRun({ left, right, comparison, address: address.trim() });
      setBusy(false);
      controller.current = null;
    }
  };

  const cancel = () => {
    controller.current?.abort();
    runNumber.current += 1;
    setBusy(false);
  };

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="SlotSleuth home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>slot<span className="brand-light">sleuth</span></span>
        </a>
        <div className="topbar-meta"><span className="topbar-dot" />SOLANA RPC TOOLKIT <span className="topbar-divider">/</span> READ ONLY</div>
        <a className="github-link" href="https://github.com/Tolu-max/SuperteamOpportunaity/tree/qa/worlds-fair-release-2026-10-11/projects/solana-live" target="_blank" rel="noreferrer">SOURCE · PRIVATE <span aria-hidden="true">↗</span></a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="kicker-line" />ACCOUNT STATE / DIAGNOSTICS 01</div>
          <h1>Inspect the read.<br /><span>Compare evidence.</span></h1>
          <p>Inspect public Solana account state through an RPC endpoint. Add a second endpoint to compare observed data, network identity, and context slots while investigating differences.</p>
          <div className="hero-note"><span className="shield-icon" aria-hidden="true">◈</span><span>No wallet connection. No transactions. Just read-only RPC.</span></div>
        </div>
        <div className="hero-graphic" aria-hidden="true">
          <div className="graphic-orbit graphic-orbit--outer" /><div className="graphic-orbit graphic-orbit--inner" />
          <div className="graphic-core"><span>STATE</span><b>≋</b></div>
          <div className="graphic-node graphic-node--a"><span>A</span></div><div className="graphic-node graphic-node--b"><span>B</span></div>
          <div className="graphic-wire graphic-wire--a" /><div className="graphic-wire graphic-wire--b" />
          <span className="graphic-label graphic-label--a">RPC / 01</span><span className="graphic-label graphic-label--b">RPC / 02</span>
          <span className="graphic-signal graphic-signal--a" /><span className="graphic-signal graphic-signal--b" />
        </div>
      </section>

      <section className="workspace" aria-labelledby="compare-title">
        <div className="section-heading"><div><span className="eyebrow">LIVE ACCOUNT INSPECTION</span><h2 id="compare-title">Inspect an account</h2></div><div className="commitment-pill"><span className="commitment-dot" />FINALIZED COMMITMENT</div></div>

        <form className="compare-form" onSubmit={handleSubmit}>
          <label className="field field--address">
            <span className="field-label"><span className="field-number">01</span> Solana account address</span>
            <div className="input-wrap input-wrap--address"><span className="input-glyph" aria-hidden="true">⌗</span><input aria-label="Solana account address" autoComplete="off" spellCheck={false} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Paste a public account address" /></div>
            <span className="field-hint">Pre-filled with the public System Program address · Base58 · No wallet required</span>
          </label>

          <div className="endpoint-fields">
            <label className="field">
              <span className="field-label"><span className="field-number">02</span> Endpoint A <span className="endpoint-chip endpoint-chip--a">REFERENCE</span></span>
              <div className="input-wrap"><span className="endpoint-dot endpoint-dot--a" /><input aria-label="Endpoint A RPC URL" autoComplete="off" spellCheck={false} type={showA ? "text" : "password"} value={endpointA} onChange={(event) => setEndpointA(event.target.value)} placeholder="https://your-rpc-endpoint" /><button className="reveal-button" type="button" onClick={() => setShowA((value) => !value)} aria-label={showA ? "Hide Endpoint A URL" : "Show Endpoint A URL"}>{showA ? "HIDE" : "SHOW"}</button></div>
              <span className="field-hint">Default: PublicNode Solana mainnet endpoint</span>
            </label>
            <div className="versus" aria-hidden="true">VS</div>
            <label className="field">
              <span className="field-label"><span className="field-number">03</span> Endpoint B <span className="endpoint-chip endpoint-chip--b">COMPARE</span></span>
              <div className="input-wrap"><span className="endpoint-dot endpoint-dot--b" /><input aria-label="Endpoint B RPC URL" autoComplete="off" spellCheck={false} type={showB ? "text" : "password"} value={endpointB} onChange={(event) => setEndpointB(event.target.value)} placeholder="Paste a second RPC URL" /><button className="reveal-button" type="button" onClick={() => setShowB((value) => !value)} aria-label={showB ? "Hide Endpoint B URL" : "Show Endpoint B URL"}>{showB ? "HIDE" : "SHOW"}</button></div>
              <span className="field-hint">Optional · same cluster recommended · browser CORS required · provider independence is not verified</span>
            </label>
          </div>

          {formError && <p className="form-error" role="alert">{formError}</p>}
          <div className="form-footer"><p><span className="privacy-icon" aria-hidden="true">◉</span> Requests go straight from this tab to the RPCs you entered. URLs are not saved by SlotSleuth.</p>
            <button className="submit-button" type="submit" disabled={busy}>{busy ? <><span className="spinner" />Reading endpoints</> : <>{endpointB.trim() ? "Compare observations" : "Inspect account"} <span aria-hidden="true">↗</span></>}</button>
          </div>
          {busy && <div className="cancel-row"><span>Reading finalized state from both RPCs…</span><button type="button" onClick={cancel}>Cancel</button></div>}
        </form>
      </section>

      {run && (
        <section className="results" aria-labelledby="results-title">
          <div className="results-heading"><div><span className="eyebrow">{run.right === null ? "SINGLE-ENDPOINT INSPECTION" : run.comparison ? "TWO-ENDPOINT OBSERVATIONS" : "TWO-ENDPOINT RESULTS · COMPARISON UNAVAILABLE"}</span><h2 id="results-title">Observed endpoint state</h2></div><div className="results-actions"><code title={run.address}>{run.address.slice(0, 8)}…{run.address.slice(-6)}</code><button className="report-button" type="button" onClick={() => downloadReport(run)}>Download JSON</button></div></div>
          {run.comparison && <ComparisonSummary run={run} />}
          <div className="result-grid"><EndpointCard label="Endpoint A" outcome={run.left} />{run.right && <EndpointCard label="Endpoint B" outcome={run.right} />}</div>
          {run.right === null && <p className="result-disclaimer" role="status">One endpoint was read. No cross-endpoint comparison was computed. Add a second RPC URL that permits browser requests to compare observations.</p>}
          {run.right !== null && !run.right.ok && run.left.ok && <p className="result-disclaimer" role="status">Endpoint A returned account data; Endpoint B did not. The successful read is preserved above, and no comparison was computed. Retry with an endpoint that permits direct browser RPC requests (CORS).</p>}
          {run.comparison && <p className="result-disclaimer">Separate finalized reads may observe state changes between requests. A difference is an observation to investigate, not proof of stale or incorrect data.</p>}
        </section>
      )}

      <footer className="page-footer"><div><span className="footer-brand">slot<span>sleuth</span></span><span className="footer-divider">·</span><span>Built for Solana developers</span></div><div><span>READ ONLY BY DESIGN</span><span className="footer-divider">·</span><a href="https://github.com/Tolu-max/SuperteamOpportunaity/tree/qa/worlds-fair-release-2026-10-11/projects/solana-live" target="_blank" rel="noreferrer">SOURCE REPO · PRIVATE ↗</a></div></footer>
    </main>
  );
}

export default App;
