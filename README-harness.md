# Reliability harness (Fineract on AWS)

This branch (`galent/reliability-harness`, based on Fineract `1.16.1`) carries only the
test-harness deployment code. Fineract source is never modified.

Allowed paths: `deploy/**`, `.github/workflows/harness-*.yml`, `README-harness.md`.

## CDK app

```
cd deploy/cdk
npm ci
npm test
npx cdk synth -c allowedCidrs=$(curl -s https://checkip.amazonaws.com)/32 --profile galent-new-dev-1
```

`allowedCidrs` (comma-separated) is required. `0.0.0.0/0` and `::/0` are rejected at synth.
Optional context: `fineractImageTag` (default `latest`).

Account: Galent dev (profile `galent-new-dev-1`), region `us-east-1`.

## Custom domain: fineract.galent.ai

- `HarnessDns` (dev account) owns a public hosted zone `fineract.galent.ai` and a DNS-validated ACM certificate.
- `HarnessApp` serves HTTPS on 443 (certificate above, path rules incl. `/fineract-provider/*`), redirects HTTP 80 to 443 (301), and adds an alias A record to the ALB. Security-group ingress on 80/443 is limited to `allowedCidrs`.
- One-time delegation: `deploy/scripts/delegate-parent-ns.sh` UPSERTs a single NS record `fineract.galent.ai.` (TTL 300) in the production `galent.ai` zone (profile `galent-prod-1`). It aborts if a non-NS record of that name exists. Run it while the first `HarnessDns` deploy waits for certificate validation (the zone exists within about a minute).
- Base URL for later tasks: `https://fineract.galent.ai`.
