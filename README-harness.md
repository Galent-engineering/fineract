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

## Architecture and URLs

Six CDK stacks in the dev account (us-east-1): `HarnessBuild` (ECR repos, CodeBuild), `HarnessData` (VPC, RDS
PostgreSQL 18 `db.t4g.small`, security groups, Cloud Map `harness.local`, DB secrets), `HarnessDns` (zone + ACM
certificate), `HarnessApp` (ALB, ECS cluster `harness` with services `fineract`, `webapp`, `traffic`, AMP workspace,
one-off task definitions), `HarnessObs` (cluster `harness-obs`, service `obs` = Tempo + Loki + nginx),
`HarnessGovernance` (Config, Resource Explorer, Resilience Hub, FIS templates, read-only reader) and `HarnessPause`
(pause flag and RDS re-stop Lambda).

- Fineract API: `https://fineract.galent.ai/fineract-provider/api/v1/...` (tenant header `Fineract-Platform-TenantId: default`)
- Mifos web app: `https://fineract.galent.ai/`
- Tempo / Loki (read only, Basic auth): `https://fineract.galent.ai/tempo/...`, `https://fineract.galent.ai/loki/...`
- Other values (ALB DNS, AMP endpoint, DB identifier): `aws cloudformation describe-stacks --stack-name <Stack> --query 'Stacks[0].Outputs'`

## Where secrets live (Secrets Manager names only)

`harness/db/admin`, `harness/db/fineract`, `harness/db/reader`, `harness/fineract/admin`, `harness/fineract/master`,
`harness/fineract/mifos`, `harness/fineract/reliability-api` (read-only API user: `username`, `password`),
`harness/obs/basic-auth`, `harness/reader/access-key`, `harness/reader/external-id`.

## Updating the allow-list

`cd deploy/cdk && npx cdk deploy HarnessData HarnessApp -c allowedCidrs=<cidr1>,<cidr2> -c fineractImageTag=<sha> -c trafficImageTag=<tag> --profile galent-new-dev-1`
(all three context values are always required; `/0` CIDRs are rejected). Check the diff first with `cdk diff`.

## First deploy on a fresh account

ECS desired counts are not managed by CloudFormation after creation (see Pause and resume), so the first deploy
sets Fineract's count explicitly, once:

1. `cdk deploy --all ... -c fineractDesiredCount=0` (Fineract would otherwise start against empty databases and crash-loop).
2. Run the one-off `harness-dbinit` task once (`aws ecs run-task`, family `harness-dbinit`) to create the databases and login.
3. `cdk deploy HarnessApp ... -c fineractDesiredCount=1` (explicit, once). From then on omit `fineractDesiredCount`
   on every deploy; the property is then not sent and the live count is left alone.

## Pause and resume

`deploy/scripts/pause.sh [--profile galent-new-dev-1]` and `deploy/scripts/resume.sh [--profile ...]` (region
us-east-1; both idempotent).

- `pause.sh` stores the current desired counts of fineract, webapp, traffic and obs as JSON in SSM
  `/harness/desired-counts` (a re-run while already at 0 keeps the earlier snapshot), sets `/harness/paused=true`,
  scales every service to 0, waits for the tasks to stop, then stops RDS and waits for `stopped`.
- `resume.sh` starts RDS and waits for `available`, restores the saved counts (1 each if none saved), sets
  `/harness/paused=false`, waits for all services to be steady, then calls
  `GET /fineract-provider/api/v1/offices` through the ALB with the `harness/fineract/reliability-api` credentials
  (read inside the script, never printed) and expects 200. `/actuator/*` is a 404 at the ALB, so the health
  endpoint is not used. Expect roughly 10-20 minutes each way, mostly RDS.
- **Pause survives `cdk deploy`.** The services no longer set `desiredCount`, so CloudFormation never resets it.
  Only pass `-c fineractDesiredCount=<n>` deliberately (first deploy); doing so while paused would start Fineract
  against a stopped database.
- **RDS auto-start guard.** AWS restarts a stopped instance after 7 days (RDS-EVENT-0154). An EventBridge rule
  invokes the `HarnessPause` Lambda (`deploy/cdk/lambda/restop_rds.py`, Python 3.12), which stops the instance
  again only when `/harness/paused` is `true` (least-privilege IAM: that parameter, plus Stop/Describe on the one
  instance). While RDS is stopped, the ECS services are also at 0, so nothing else needs guarding.
- Lambda tests: `cd deploy/cdk && uv run --with boto3 --with pytest pytest lambda -v`.

## Estimated monthly cost

us-east-1 list prices (AWS Price List API, Nov 2026), 730 h/month, no savings plans. Estimates, not bills.

| Component | Running | Paused |
|---|---|---|
| Fargate fineract (2 vCPU, 8 GB) | $85 | 0 |
| Fargate obs (1 vCPU, 4 GB) | $43 | 0 |
| Fargate webapp + traffic (0.25 vCPU, 0.5 GB each) | $18 | 0 |
| Public IPv4 on tasks (4) | $15 | 0 |
| RDS db.t4g.small instance ($0.032/h) | $23 | 0 (stopped) |
| RDS gp3 storage 20 GB + 1-day backups | $3 | $3 |
| ALB ($0.0225/h + ~min LCU) + 2 public IPv4 | $29 | $29 |
| Secrets Manager (10 secrets) | $4 | $4 |
| AWS Config recorder | ~$4 | ~$4 |
| Resilience Hub application | ~$15 | ~$15 |
| AMP (ingest + storage) | ~$8 | ~$2 (storage only) |
| CloudWatch Logs, S3 (Tempo/Loki), Cloud Map, Route 53, Lambda | ~$6 | ~$3 |
| **Total** | **~$250** | **~$60** |

Paused still pays for the ALB (and its IPv4 addresses), RDS storage, Secrets Manager, the Config recorder,
Resilience Hub, and AMP/log storage. Teardown is the only way to reach zero.

Check actuals after 7 days. The harness resources carry no cost-allocation tag and the dev account is shared with
other workloads, so filter by service and read the harness-relevant lines (ECS, RDS, ELB, Secrets Manager, Config,
Resilience Hub, Prometheus); do not read the account total as harness cost:

```
aws ce get-cost-and-usage --profile galent-new-dev-1 --region us-east-1 \
  --time-period Start=$(date -v-7d +%F),End=$(date +%F) --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Elastic Container Service","Amazon Relational Database Service","Amazon Elastic Load Balancing","AWS Secrets Manager","AWS Config","AWS Resilience Hub","Amazon Managed Service for Prometheus"]}}'
```

(`date -v-7d` is macOS; on Linux use `date -d '7 days ago' +%F`.) If the `aws:cloudformation:stack-name` tag is
activated as a cost-allocation tag in Billing, add `Tags` filtering on `Harness*` stacks instead.

## Teardown

1. Remove the production NS delegation first (otherwise a dangling delegation could be taken over):
   `PARENT_ZONE_ID=<parent zone id> PARENT_PROFILE=<prod profile> deploy/scripts/remove-parent-ns.sh` prints the exact
   DELETE batch (using the live NS values); add `--yes` to submit it. This is the only production write besides the one-time delegation.
2. Then `npx cdk destroy --all` with the same three context values (`HarnessDns` only after step 1).
3. Secrets with fixed names (`harness/db/*`, `harness/fineract/*`, `harness/obs/basic-auth`) are deleted with a
   recovery window, so a redeploy right after a destroy can fail with "scheduled for deletion". Purge them first:
   `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`.
4. RDS is created with a final snapshot on delete (`removalPolicy: SNAPSHOT`), and RDS keeps automated backups
   only for 1 day. After the destroy, delete the leftover final snapshot (`aws rds describe-db-snapshots
   --snapshot-type manual`, then `aws rds delete-db-snapshot --db-snapshot-identifier <id>`) unless you want it.
   Also check the CloudWatch log groups of the stacks if you want them gone.
