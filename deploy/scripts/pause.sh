#!/usr/bin/env bash
# Pause the harness: save desired counts, scale all ECS services to 0, stop the RDS instance.
# Idempotent: re-running while paused is a no-op success. Resume with resume.sh.
# Usage: pause.sh [--profile <aws profile>]   (default galent-new-dev-1, region us-east-1)
set -euo pipefail

PROFILE=galent-new-dev-1
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "usage: $0 [--profile <name>]" >&2; exit 2 ;;
  esac
done
export AWS_PROFILE="$PROFILE" AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

# cluster:service pairs (obs lives in its own cluster)
SERVICES="harness:fineract harness:webapp harness:traffic harness-obs:obs"

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
wait_db() { # wait_db <status>
  local i st=""
  for i in $(seq 1 "$DB_WAIT_MAX"); do
    st=$(db_status)
    [ "$st" = "$1" ] && return 0
    die_if_terminal "$st"
    echo "  rds: $st (waiting for $1)"; sleep 30
  done
  timed_out "to reach $1" "$st"
}

# 1. Save current counts. Never overwrite an existing snapshot while already paused (a re-run after a partial
#    failure would otherwise record the half-scaled 0s), and never record an all-zero state.
# Only ParameterNotFound means "not paused"; any other read error (throttling, auth) aborts before anything changes.
if already=$(aws ssm get-parameter --name /harness/paused --query Parameter.Value --output text 2>&1); then
  :
elif printf '%s' "$already" | grep -q ParameterNotFound; then
  already=false
else
  echo "FAILED: cannot read /harness/paused: $already" >&2; exit 1
fi
counts='{}'; total=0
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  n=$(aws ecs describe-services --cluster "$c" --services "$s" --query 'services[0].desiredCount' --output text)
  counts=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=int(sys.argv[3]); print(json.dumps(d))' "$counts" "$cs" "$n")
  total=$((total + n))
done
if [ "$already" = true ]; then
  echo "already paused; keeping saved counts"
elif [ "$total" -gt 0 ]; then
  aws ssm put-parameter --name /harness/desired-counts --type String --overwrite --value "$counts" >/dev/null
  echo "saved desired counts: $counts"
else
  echo "all services already at 0; keeping saved counts"
fi

# 2. Flag first, so the re-stop Lambda is armed before anything goes down.
aws ssm put-parameter --name /harness/paused --type String --overwrite --value true >/dev/null

# 3. Scale to 0 and wait for the tasks to drain.
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  aws ecs update-service --cluster "$c" --service "$s" --desired-count 0 >/dev/null
done
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  waited=0
  until aws ecs wait services-stable --cluster "$c" --services "$s"; do
    waited=$((waited + 1))
    [ "$waited" -lt 4 ] || { echo "FAILED: $s did not drain" >&2; exit 1; }
    sleep 15
  done
  echo "$s: 0 running"
done

# 4. Stop the database (wait out transitional states first, bounded).
st=""
for _ in $(seq 1 "$DB_WAIT_MAX"); do
  st=$(db_status)
  die_if_terminal "$st"
  case "$st" in
    available) aws rds stop-db-instance --db-instance-identifier "$DB" >/dev/null; echo "stopping $DB"; break ;;
    stopped|stopping) break ;;
    *) echo "  rds: $st (waiting)"; sleep 30 ;;
  esac
done
case "$st" in available|stopped|stopping) ;; *) timed_out "to leave '$st'" "$st" ;; esac
wait_db stopped
echo "paused: services at 0, $DB stopped"
