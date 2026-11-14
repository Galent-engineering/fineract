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
wait_db() { # wait_db <status>
  while [ "$(db_status)" != "$1" ]; do echo "  rds: $(db_status) (waiting for $1)"; sleep 30; done
}

# 1. Save current counts, unless everything is already 0 (re-run: keep the earlier snapshot).
counts='{}'; total=0
for cs in $SERVICES; do
  c=${cs%%:*}; s=${cs##*:}
  n=$(aws ecs describe-services --cluster "$c" --services "$s" --query 'services[0].desiredCount' --output text)
  counts=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=int(sys.argv[3]); print(json.dumps(d))' "$counts" "$cs" "$n")
  total=$((total + n))
done
if [ "$total" -gt 0 ]; then
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
  aws ecs wait services-stable --cluster "$c" --services "$s"
  echo "$s: 0 running"
done

# 4. Stop the database (wait out transitional states first).
while :; do
  st=$(db_status)
  case "$st" in
    available) aws rds stop-db-instance --db-instance-identifier "$DB" >/dev/null; echo "stopping $DB"; break ;;
    stopped|stopping) break ;;
    *) echo "  rds: $st (waiting)"; sleep 30 ;;
  esac
done
wait_db stopped
echo "paused: services at 0, $DB stopped"
