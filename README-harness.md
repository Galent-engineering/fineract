# Reliability harness (Fineract on AWS)

This branch (`galent/reliability-harness`, based on Fineract `1.16.1`) carries only the
test-harness deployment code. Fineract source is never modified.

Allowed paths: `deploy/**`, `.github/workflows/harness-*.yml`, `README-harness.md`.

## CDK app

```
cd deploy/cdk
npm ci
npm test
npx cdk synth -c allowedCidrs=$(curl -s https://checkip.amazonaws.com)/32 -c fineractImageTag=<sha> --profile galent-new-dev-1
```

`allowedCidrs` (comma-separated) is required. `0.0.0.0/0` and `::/0` are rejected at synth.
`fineractImageTag` is also required (no default; `latest` is rejected): pass the git sha of an image pushed to
`harness/fineract`, e.g. `-c fineractImageTag=<sha>`. Synth fails with a clear error without it. Every
`cdk deploy`/`cdk diff` must pass it, otherwise the task definition would silently move.

Account: Galent dev (profile `galent-new-dev-1`), region `us-east-1`.

## Custom domain: fineract.galent.ai

- `HarnessDns` (dev account) owns a public hosted zone `fineract.galent.ai` and a DNS-validated ACM certificate.
- `HarnessApp` serves HTTPS on 443 (certificate above, path rules incl. `/fineract-provider/*`), redirects HTTP 80 to 443 (301), and adds an alias A record to the ALB. Security-group ingress on 80/443 is limited to `allowedCidrs`.
- One-time delegation: `PARENT_ZONE_ID=<parent zone id> PARENT_PROFILE=<prod profile> deploy/scripts/delegate-parent-ns.sh` UPSERTs a single NS record `fineract.galent.ai.` (TTL 300) in the production `galent.ai` zone (both values come from the environment; no production identifiers are committed). It aborts if a non-NS record of that name exists. Run it while the first `HarnessDns` deploy waits for certificate validation (the zone exists within about a minute).
- Base URL for later tasks: `https://fineract.galent.ai`.

## Security posture of the ALB and observability proxy

- HTTPS listener uses `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.2+).
- `/actuator/*` and `/fineract-provider/actuator/*` return a fixed 404 on both listeners (priority 5, above the
  Fineract rule). Metrics reach AMP through the ADOT sidecar scraping `localhost:8080`; target-group health checks
  hit the targets directly and are unaffected. Read metrics from AMP, not the ALB.
- `/tempo/*` and `/loki/*` go through nginx with Basic auth (secret `harness/obs/basic-auth`, user `reliability`).
  Only read endpoints are allowed: Tempo GET/HEAD on echo, search, tags, tag values and traces; Loki GET/HEAD on
  query, query_range, labels, label values, series, index/stats, plus POST on query, query_range and series. Everything
  else (push, delete, flush, shutdown, config, ring, admin, metrics) returns 403. `/healthz` is the only unauthenticated path.
- ECS services (Fineract, webapp, obs) use a deployment circuit breaker with rollback. With `minHealthyPercent: 0`
  every roll is an outage of a few minutes (Fineract boots slowly); that trade-off is deliberate, for cost.

## Telemetry gap when the obs task rolls

Tempo and Loki run as one task with task-local storage (WAL and ingester chunks), backed by S3 for flushed data.
Any roll of the obs task (config change, image bump, forced deployment, Fargate host retirement) drops whatever has
not been flushed yet and, with `minHealthyPercent: 0`, nothing ingests while it restarts (FireLens retries, then
drops; ADOT retries traces). Loki is tuned to `chunk_idle_period: 1m` / `max_chunk_age: 5m` so at most a few
minutes of logs are at risk. Treat a gap around an obs deployment as a harness artefact, not as "no logs/traces
during the incident". No EFS is used (cost/complexity).

## First deploy on a fresh account

1. `cdk deploy --all ... -c fineractDesiredCount=0` (Fineract would otherwise start against empty databases and crash-loop).
2. Run the one-off `harness-dbinit` task once (`aws ecs run-task`, family `harness-dbinit`) to create the databases and login.
3. `cdk deploy HarnessApp ... -c fineractDesiredCount=1` (the default).

## Teardown

1. Remove the production NS delegation first (otherwise a dangling delegation could be taken over):
   `PARENT_ZONE_ID=<parent zone id> PARENT_PROFILE=<prod profile> deploy/scripts/remove-parent-ns.sh` prints the exact
   DELETE batch (using the live NS values); add `--yes` to submit it. This is the only production write besides the one-time delegation.
2. Then `cdk destroy` the stacks (`HarnessDns` only after step 1).
3. Secrets with fixed names (`harness/db/*`, `harness/fineract/*`, `harness/obs/basic-auth`) are deleted with a
   recovery window, so a redeploy right after a destroy can fail with "scheduled for deletion". Purge them first:
   `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`.
