# SlotSleuth

SlotSleuth helps Solana application developers compare finalized public-account state from two RPC endpoints. It checks genesis fingerprints, finalized and account-context slots, account existence, owner, lamports, executable flag, data length, and SHA-256 of account data.

## Run and verify

From the repository root:

```sh
npm ci
npm run dev
npm run typecheck --workspace @worlds-fair/solana-live
npm run lint --workspace @worlds-fair/solana-live
npm run test --workspace @worlds-fair/solana-live
npm run build --workspace @worlds-fair/solana-live
```

The Vite server prints a local URL (5173 by default). No environment variables are required; see [.env.example](.env.example). The static build is `projects/solana-live/dist`.

## Behavior and boundaries

- Uses `@solana/kit` for validated public addresses and JSON-RPC reads at finalized commitment. Lamports remain `bigint` for exact comparisons.
- Endpoint A defaults to `https://solana-rpc.publicnode.com`; supply a second endpoint. The browser sends requests directly to each provider. Provider availability, CORS, and rate limits differ.
- Retries an individual transient 408/425/429/5xx or network failure once after a short delay. It does not retry invalid requests or rate-limit indefinitely.
- Hashes account data locally up to 10 MiB; larger data is marked unverified. Endpoint URLs are only in tab memory and are intentionally omitted from downloaded diagnostic JSON.
- Genesis hash, slot height, and account state are separate RPC reads, and the two endpoints are not queried at one atomic shared slot. A mismatch is a diagnostic signal, not proof that a provider is faulty.
- There is no backend, analytics, wallet connection, or transaction method. Never paste a wallet secret. A provider URL can contain a credential and will be sent to that provider.

## Demo and deployment

Use a public account address and two distinct HTTPS RPC URLs for the same cluster. Show the genesis fingerprint, context slots, account fields, hash comparison, then export the JSON diagnostic. State that state may advance between reads and that nothing is signed or broadcast.

Build with `npm run build --workspace @worlds-fair/solana-live` from the repository root and publish `projects/solana-live/dist` using a static host configured for this monorepo. No hosting provider, public URL, or deployment credential is configured or verified. The repository is private; obtain the user's approval before changing repository visibility or publishing its code.

## Live smoke evidence

Chromium sent a real mainnet request to PublicNode for the System Program account and rendered its owner, executable flag, balance, data size, hash, and context slot. This confirms one live endpoint's browser RPC path. The alternate public Solana host tested in this environment returned HTTP 403 from the browser; use a second provider that supports browser CORS for a meaningful independent comparison. Local JSON-RPC fixtures separately cover matching/comparison logic, retries, errors, and export behavior.
