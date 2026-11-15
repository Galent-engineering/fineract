# Reliability harness (Fineract on AWS)

This branch (`galent/reliability-harness`, based on Fineract `1.16.1`) carries only the
test-harness deployment code. Fineract source is never modified.

Allowed paths: `deploy/**`, `.github/workflows/harness-*.yml`, `README-harness.md`.

## CDK app

```
cd deploy/cdk
npm ci
npm test
npx cdk synth -c allowedCidrs=$(curl -s https://checkip.amazonaws.com)/32 -c fineractImageTag=<sha> -c trafficImageTag=<sha> --profile galent-new-dev-1
```

`allowedCidrs` (comma-separated) is required. `0.0.0.0/0` and `::/0` are rejected at synth.
`fineractImageTag` and `trafficImageTag` are also required (no default; `latest` is rejected): pass the git sha (or
tag) of an image pushed to `harness/fineract` / `harness/traffic`, e.g. `-c fineractImageTag=<sha>`. Synth fails
with a clear error without them. Every `cdk deploy`/`cdk diff` must pass both, otherwise the task definitions would
silently move.

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
   The `traffic` service has no such context and is created with 1 task: **scale it to 0 straight away**
   (`aws ecs update-service --cluster harness --service traffic --desired-count 0`), because there is no
   `harness_admin` user until the seed has run (the traffic task retries its startup for 10 minutes, then exits).
2. Run the one-off `harness-dbinit` task once (`aws ecs run-task`, family `harness-dbinit`) to create the databases and login.
3. `cdk deploy HarnessApp ... -c fineractDesiredCount=1` (explicit, once). From then on omit `fineractDesiredCount`
   on every deploy; the property is then not sent and the live count is left alone.
4. Run the one-off `harness-seed` task (creates reference data, `harness_admin`, the read-only API role and user,
   rotates `mifos`), then the `harness-dbreadergrant` task (creates `reliability_reader`), then scale `traffic` to 1.
   Run `harness-seed` with the network configuration of the `traffic` service (security group `TrafficSg`, the only
   source allowed to reach Fineract on 8080); `harness-dbreadergrant` and `harness-dbinit` use the `fineract` service's.

## Pause and resume

`deploy/scripts/pause.sh [--profile galent-new-dev-1]` and `deploy/scripts/resume.sh [--profile ...]` (region
us-east-1; both idempotent).

- `pause.sh` stores the current desired counts of fineract, webapp, traffic and obs as JSON in SSM
  `/harness/desired-counts` (never overwritten while `/harness/paused` is already `true`, and never with an all-zero
  state, so a re-run after a partial failure keeps the good snapshot), sets `/harness/paused=true`,
  scales every service to 0, waits for the tasks to stop, then stops RDS and waits for `stopped`.
- `resume.sh` starts RDS and waits for `available`, restores the saved counts (1 for a service missing from the snapshot or when there is no snapshot; any other SSM
  error aborts), sets `/harness/paused=false`, waits for all services to be steady (at most 4 waits per service, with
  the error shown, then it exits 1), clears the snapshot, then calls
  `GET /fineract-provider/api/v1/offices` through the ALB with the `harness/fineract/reliability-api` credentials
  (read inside the script, never printed) and expects 200. `/actuator/*` is a 404 at the ALB, so the health
  endpoint is not used. Measured: 7m26s to pause and 7m38s to resume, mostly RDS. Credentials are passed to curl on stdin, not in argv.
- **Pause survives `cdk deploy`.** The services no longer set `desiredCount`, so CloudFormation never resets it.
  Only pass `-c fineractDesiredCount=<n>` deliberately (first deploy); doing so while paused would start Fineract
  against a stopped database.
- **RDS auto-start guard.** AWS restarts a stopped instance after 7 days (RDS-EVENT-0154). An EventBridge rule
  invokes the `HarnessPause` Lambda (`deploy/cdk/lambda/restop_rds.py`, Python 3.12), which stops the instance
  again only when `/harness/paused` is `true` (least-privilege IAM: that parameter, plus Stop/Describe on the one
  instance). The event arrives while the instance is still `starting`, so the Lambda (timeout 15 min) waits up to
  13 min for `available`, re-reads the flag (resume may have run meanwhile), then stops it. While RDS is stopped, the ECS services are also at 0, so nothing else needs guarding.
- Lambda tests: `cd deploy/cdk && uv run --with boto3 --with pytest pytest lambda -v`. Script tests (stub `aws`):
  `cd deploy/scripts && uv run --with pytest pytest tests -v`.

## Demo scenarios

Break the harness on purpose, watch monitoring react, and let it recover by itself. One command each, from `deploy/scripts`:

| Command | What it does | Duration |
| --- | --- | --- |
| `./demo.sh db-outage` | Fineract cannot reach Postgres (egress tcp 5432 blackholed). It keeps serving HTTP and answers 5xx. | 4 min |
| `./demo.sh slowdown` | About 1500 ms of network latency on the Fineract task; responses get slow. | 4 min |
| `./demo.sh crash` | Stops the Fineract task; ECS starts a replacement (about 7-10 min until healthy). | until replaced |
| `./demo.sh on` / `off` | Traffic rate 60 / 6 journeys per minute (SSM `/harness/traffic/rate_per_min`, read by the traffic task about once a minute, bounds 1..120). Prints the before and after value. | until changed |
| `./demo.sh status` | Active and recent scenario experiments, traffic rate, Fineract running count. | |
| `./demo.sh stop` | Ends a running scenario early. | |

- Each scenario is an AWS FIS experiment template in `HarnessApp` (tag `harness-scenario=<name>`), targeting only the `fineract`
  service in cluster `harness`. The 4-minute limit is the action's own duration, so every scenario reverts on its own;
  there is no stop-condition alarm. `demo.sh` refuses to start while the harness is paused or another scenario is running,
  and waits (bounded) for the experiment to end and Fineract to be back at its desired count.
- Fault injection needs the Fineract task definition to run with `enableFaultInjection`, `pidMode: task` and an SSM-agent
  sidecar (`amazon-ssm-agent`) that registers the task as an SSM managed instance (per the AWS FIS ECS task actions
  documentation). The sidecar runs `dnf upgrade` at start, which needs outbound internet (the tasks have public IPs).
  Turning this on rolls the Fineract task once.
- Slowdown delays all egress of the Fineract task, database calls included, so every query pays the delay.
- Cost: AWS FIS bills $0.10 per action-minute (one account, us-east-1; see https://aws.amazon.com/fis/pricing/), so a 4-minute
  scenario is about $0.40 and `crash` under $0.10. Nothing is billed while no experiment runs.
- Run these only against this harness. The FIS role is scoped to cluster `harness`, but never point `--profile` at another
  account or reuse the templates for anything else.

## Estimated monthly cost

us-east-1 list prices (AWS Price List API, Nov 2026), 730 h/month, no savings plans. Estimates, not bills.

| Component | Running | Paused |
|---|---|---|
| Fargate fineract (2 vCPU, 8 GB) | $85 | 0 |
| Fargate obs (1 vCPU, 4 GB) | $43 | 0 |
| Fargate webapp + traffic (0.25 vCPU, 0.5 GB each) | $18 | 0 |
| Public IPv4 on tasks (4) | $15 | 0 |
| RDS db.t4g.small instance ($0.032/h) | $23 | 0 (stopped) |
| RDS gp3 storage 20 GB (autoscales to a 50 GB cap) + 1-day backups | $3 | $3 |
| X-Ray (sampled, ~1.3M traces/month at ~$5 per million) | ~$6 | ~$6 (no traffic: ~$0) |
| ALB ($0.0225/h + ~min LCU) + 2 public IPv4 | $29 | $29 |
| Secrets Manager (10 secrets) | $4 | $4 |
| AWS Config recorder (guess; billed per configuration item, account-wide in a shared account) | ~$4 | ~$4 |
| Resilience Hub application | ~$15 | ~$15 |
| AMP (ingest + storage) | ~$8 | ~$2 (storage only) |
| CloudWatch Logs, S3 (Tempo/Loki), Cloud Map, Route 53, Lambda | ~$6 | ~$3 |
| **Total** | **~$256** | **~$60** |

Paused still pays for the ALB (and its IPv4 addresses), RDS storage, Secrets Manager, the Config recorder,
Resilience Hub, and AMP/log storage. Teardown is the only way to reach zero.

Storage: the journeys add about 190 MB/day (about 20 KB each, 8,640 per day), so the 20 GB disk would fill in about
3 months; RDS storage autoscaling (`maxAllocatedStorage: 50`) grows it automatically up to 50 GB. Config, Resilience Hub
and AMP figures are guesses.

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
3. Secrets with fixed names (`harness/db/*`, `harness/fineract/*`, `harness/obs/basic-auth`, `harness/reader/external-id`,
   `harness/reader/access-key`) are deleted with a recovery window, so a redeploy right after a destroy can fail with
   "scheduled for deletion". Purge them first:
   `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`. The SSM parameter
   `/harness/desired-counts` is created by `pause.sh`, not by CDK, so it survives `cdk destroy`:
   `aws ssm delete-parameter --name /harness/desired-counts`.
4. RDS is created with a final snapshot on delete (`removalPolicy: SNAPSHOT`), and RDS keeps automated backups
   only for 1 day. After the destroy, delete the leftover final snapshot (`aws rds describe-db-snapshots
   --snapshot-type manual`, then `aws rds delete-db-snapshot --db-snapshot-identifier <id>`) unless you want it.
   Also check the CloudWatch log groups of the stacks if you want them gone.

## Reader role scope (`HarnessGovernance`)

The connector user `harness-reliability-connector` can only `sts:AssumeRole` into `harness-reliability-reader`
(external id in `harness/reader/external-id`). The role is read-only (an exact action list is pinned in
`governance-stack.test.ts`) and, because the dev account is shared, scoped to the harness where AWS allows it:

- CloudWatch Logs: `FilterLogEvents`, `StartQuery`, `DescribeLogStreams` on log groups `/harness*` only.
- ECS: Describe/List on clusters `harness` and `harness-obs`, their services and tasks. `DescribeTaskDefinition` is
  not granted: IAM cannot scope it (it is evaluated on `*`), and other teams' task definitions carry plaintext
  environment variables. Image, cpu and memory are still visible through `DescribeServices`/`DescribeTasks`.
- AMP: query/get on the harness workspace only. RDS: `DescribeDBInstances` on the harness instance.
- **Still account-wide** (no resource-level support): X-Ray, CloudWatch metrics, Resource Explorer search, Resilience Hub, FIS, ELB describe, and name-only
  listings (`ecs:ListClusters`, `logs:DescribeLogGroups`, `rds:DescribeEvents`).
- AWS Config reads are deliberately not granted, because of historic configuration items from other teams in the shared account. Re-add them only with a Config reader adapter and after those items leave retention.
- The Resource Explorer index and default view are reused, not managed here; deleting them breaks `Search`.

## CI deploy

`.github/workflows/harness-build.yml` runs on a push to `galent/reliability-harness` that touches `deploy/**`,
`fineract-*/**`, `build.gradle`, `settings.gradle`, `gradle/**` or the workflow itself (a docs-only push, including
this README, runs nothing), and on manual dispatch. Runs are serialised per ref (`concurrency` group
`harness-<ref>`, no cancel), so a later push waits for the one mid-deploy.

- **build** job: assumes `harness-github-ci` (variable `HARNESS_CI_ROLE_ARN`), which holds ECR push/pull on the two
  repos and nothing else. It builds both images (the traffic image with `--provenance=false --sbom=false`, one
  manifest per push).
- **deploy** job: runs only on a push to the branch and only when the repo variable `HARNESS_DEPLOY` is `true`.
  It installs the CDK app (`npm ci --ignore-scripts`, before any credential exists), assumes `harness-github-deploy`
  (variable `HARNESS_DEPLOY_ROLE_ARN`), and runs `cdk deploy HarnessApp --exclusively` with
  `fineractImageTag=<commit sha>` and `trafficImageTag=<commit sha>`, then waits for `aws ecs wait services-stable`.
- The two roles trust different OIDC subjects (immutable-id form, prefix `repo:Galent-engineering@219138393/fineract@1456802084`):
  `harness-github-ci` only `...:ref:refs/heads/galent/reliability-harness` (the build job), `harness-github-deploy`
  only `...:environment:harness-deploy` (the deploy job declares `environment: harness-deploy`). A token minted in the
  build job therefore cannot assume the deploy role, and the deploy job's token cannot assume the build role. The
  GitHub environment `harness-deploy` has a deployment branch policy allowing only `galent/reliability-harness` and no
  required reviewers. `harness-github-deploy` can only assume the CDK bootstrap roles and describe ECS services.
  The CFN execution role from bootstrap is broad by default; this is accepted for the dev account.
- ECR keeps the newest 30 images per repo and expires untagged manifests after 7 days.

- `allowedCidrs` comes from the repository secret `HARNESS_ALLOWED_CIDRS` (a secret, not a variable: public repo logs).
  CI only deploys `HarnessApp`, which does not use it (only `HarnessData` consumes `allowedCidrs`), so the value only
  has to be a valid CIDR to get through synth; a stale value matters only for a local `cdk deploy HarnessData`/`--all`.
  Update it with `gh secret set HARNESS_ALLOWED_CIDRS -R Galent-engineering/fineract -b "<cidr>"`.
- Changes to `HarnessBuild` (including the role policies) are deployed locally, never by CI. After deploying it, set
  the variables: `gh variable set HARNESS_DEPLOY_ROLE_ARN -R Galent-engineering/fineract -b <role arn>` (always pass
  `-R`; the clone's default remote is upstream Apache).
- **Image tags after a CI deploy.** The deployed tag is whatever the last CI deploy used; read it with
  `aws ecs describe-task-definition` and pass it to local `cdk` commands, otherwise a local deploy rolls the image back:

  ```
  aws ecs describe-task-definition --profile galent-new-dev-1 --region us-east-1 \
    --task-definition "$(aws ecs describe-services --cluster harness --services fineract --profile galent-new-dev-1 --region us-east-1 --query 'services[0].taskDefinition' --output text)" \
    --query 'taskDefinition.containerDefinitions[?name==`fineract`].image' --output text
  # same for the traffic service: --services traffic and containerDefinitions[?name==`traffic`]
  ```

## App Mod estate project

- **Platform:** the local Galent platform, App Mod. The project is "Fineract Core Banking", id `6af7d03a9e53993ec9b861f0`. Its source is `Galent-engineering/fineract`, branch `galent/reliability-harness`, mapped to one application, "fineract".
- **Ingestion** (8,194 files, 1.21M lines, 27 languages, 55 components):

  | Ingested | Metadata only | Excluded | Failed |
  |---|---|---|---|
  | 8,039 | 495 | 23 | 1 |

- **Code enrichment:** completed. Of the eligible files, 1,790 were enriched by the model. Cost was $16.57 on `claude-haiku-4-5`.
- **Estate discovery:** completed, 22 of 22 sections, after a platform fix for section A2 "Capabilities & features", whose output was cut off on large estates. Discovery cost about $13.24 across the first run and three retries.
- **Discovery results:** 43 capabilities, 5 personas, 365 data tables, 26 integrations, 38 transactions, 30 endpoints.
