# SlotSleuth

SlotSleuth helps Solana application developers check whether two RPC providers return the same finalized state for a public account. It compares cluster genesis fingerprints, finalized and account-context slots, account existence, owner, balance, executable flag, data length, and a SHA-256 of account data.

## Run locally

From the repository root:

```sh
npm ci
npm run dev
```

Open the Vite URL, paste a public account address, enter two distinct RPC URLs, and select **Compare account state**. Endpoint A starts with Solana's public mainnet endpoint. Endpoint B must be supplied by the developer. The page does not fetch data until the form is submitted.

## How it works

- Uses the current modular `@solana/kit` SDK to validate public addresses and read `getGenesisHash`, `getSlot`, and `getAccountInfo` at `finalized` commitment. Lamport amounts stay as `bigint` for exact comparison.
- Queries both endpoints concurrently and displays the account context slot beside each response.
- Computes a local SHA-256 over account data up to 10 MiB. It never uploads account bytes to a SlotSleuth service.
- Labels familiar mainnet, devnet, and testnet genesis hashes. It shows an unknown fingerprint for other clusters rather than guessing.
- Keeps entered RPC URLs only in tab memory. The selected RPC provider receives the request, address, and the URL itself; SlotSleuth has no backend, analytics, wallet connection, or transaction methods.
- Allows HTTP only for loopback validator endpoints; remote endpoints must use HTTPS. Never paste a wallet secret. An RPC URL may itself contain a provider API key and will be sent to that provider.

## Comparison limits

Two reads can straddle a finalized account update. A reported difference is a signal to investigate, not proof that a provider is wrong. Compare account context slots and repeat the read before diagnosing stale state. SlotSleuth flags lamport values outside JavaScript's exact integer range as unverified and skips hashing data over 10 MiB. Rate limits and browser CORS rules depend on the RPC provider.

## Validation

```sh
npm run typecheck
npm run lint
npm run test
npm run build
```

The test suite includes a local JSON-RPC server that exercises the Solana SDK request and account-decoding path. A live mainnet smoke check still needs outbound access to `api.mainnet-beta.solana.com` and is not counted as passed until that request succeeds.

## Demo plan

Use two RPC providers configured for the same cluster and the same public account address. Show both genesis fingerprints, finalized slots, account context slots, owner, and data hash. Repeat after an account update has finalized if one is available. State clearly that no transaction is signed or sent and that provider credentials in endpoint URLs remain with the provider receiving each request.

## Environment variables

None are required. See [.env.example](.env.example). Provider URLs are supplied in the browser and are never written to local storage.

## Deployment

Build with `npm run build` from the repository root. The generated static site is in `projects/solana-live/dist`. Deployment has not been configured or verified; select a host only after authorized deployment credentials and hackathon requirements are known.
