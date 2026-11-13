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
