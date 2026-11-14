#!/usr/bin/env bash
# Resume the harness: start RDS, wait until available, restore ECS desired counts, clear the paused flag,
# then verify Fineract through the ALB. Idempotent.
# Usage: resume.sh [--profile <aws profile>]   (default galent-new-dev-1, region us-east-1)
set -euo pipefail

PROFILE=galent-new-dev-1
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "usage: $0 [--profile <name>]" >&2; exit 2 ;;
  esac
done
export AWS_PROFILE="$PROFILE" AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

DB=$(aws cloudformation describe-stacks --stack-name HarnessPause \
  --query "Stacks[0].Outputs[?OutputKey=='DbInstanceIdentifier'].OutputValue" --output text)
[ -n "$DB" ] && [ "$DB" != "None" ] || { echo "HarnessPause stack not deployed" >&2; exit 1; }
db_status() { aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text; }

# Every DB wait is bounded: DB_WAIT_MAX polls x 30 s (default 40 = 20 min), then a clear error. A terminal state
# (it will never become available/stopped without a human) aborts at once.
DB_WAIT_MAX=${DB_WAIT_MAX:-40}
die_if_terminal() { # die_if_terminal <status>
  case "$1" in
    failed|storage-full|incompatible-*|inaccessible-encryption-credentials)
      echo "FAILED: $DB is in terminal state '$1'; fix it in the RDS console, then re-run" >&2; exit 1 ;;
  esac
}
timed_out() { echo "FAILED: timed out after $DB_WAIT_MAX polls waiting for $DB ($1); last status '$2'" >&2; exit 1; }
# 1. Start the database and wait for it. (Flag stays "true" until the DB is up, so the re-stop Lambda
#    cannot be fooled; RDS-EVENT-0154 is only raised for the 7-day auto-start, not for a manual start.)
st=""
for _ in $(seq 1 "$DB_WAIT_MAX"); do
  st=$(db_status)
  die_if_terminal "$st"
  case "$st" in
    stopped) aws rds start-db-instance --db-instance-identifier "$DB" >/dev/null; echo "starting $DB" ;;
    available) break ;;
    *) echo "  rds: $st (waiting)" ;;
  esac
  sleep 30
done
[ "$st" = available ] || timed_out "to become available" "$st"
aws rds wait db-instance-available --db-instance-identifier "$DB"
echo "rds available"

# 2. Restore the counts saved by pause.sh. A missing snapshot (ParameterNotFound) or a service missing from it
#    falls back to 1; any other SSM error aborts rather than silently turning a deliberate 0 into 1.
if saved=$(aws ssm get-parameter --name /harness/desired-counts --query Parameter.Value --output text 2>&1); then
  have_snapshot=1
elif printf '%s' "$saved" | grep -q ParameterNotFound; then
  saved='{}'; have_snapshot=0
else
  echo "FAILED: cannot read /harness/desired-counts: $saved" >&2; exit 1
fi
SERVICES="harness:fineract harness:webapp harness:traffic harness-obs:obs"
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  n=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], 1))' "$saved" "$cs")
  aws ecs update-service --cluster "$c" --service "$s" --desired-count "$n" >/dev/null
  echo "$s -> $n"
done
aws ssm put-parameter --name /harness/paused --type String --overwrite --value false >/dev/null

# 3. Wait for steady state (Fineract boots slowly; each waiter polls up to ~10 min). At most 4 attempts per
#    service, with a pause and the real error shown, so an expired token or AccessDenied cannot spin forever.
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  attempt=0
  until err=$(aws ecs wait services-stable --cluster "$c" --services "$s" 2>&1); do
    attempt=$((attempt + 1))
    echo "  $s not steady yet (attempt $attempt/4): $(printf '%s' "$err" | tail -n 1)" >&2
    [ "$attempt" -lt 4 ] || { echo "FAILED: $s never became steady" >&2; exit 1; }
    sleep 15
  done
  echo "$s steady"
done
# The snapshot has served its purpose; clearing it stops a later re-run applying stale counts.
[ "$have_snapshot" = 1 ] && aws ssm delete-parameter --name /harness/desired-counts >/dev/null || true

# 4. Verify through the ALB. /actuator is 404 at the ALB, so call an authenticated API with the read-only
#    API user; credentials are read into variables here and never printed.
SECRET=$(aws secretsmanager get-secret-value --secret-id harness/fineract/reliability-api --query SecretString --output text)
FUSER=$(printf '%s' "$SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["username"])')
FPASS=$(printf '%s' "$SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')
unset SECRET
URL=https://fineract.galent.ai/fineract-provider/api/v1/offices
code=000
for _ in $(seq 1 40); do
  # credentials go through a curl config on stdin so they never appear in `ps`
  code=$(printf 'user = "%s:%s"\n' "$FUSER" "$FPASS" | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -K - \
    -H 'Fineract-Platform-TenantId: default' "$URL" || true)
  [ "$code" = 200 ] && break
  echo "  offices -> $code"; sleep 15
done
[ "$code" = 200 ] || { echo "FAILED: offices returned $code" >&2; exit 1; }
echo "resumed: GET /api/v1/offices -> 200"
