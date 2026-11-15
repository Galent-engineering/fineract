#!/usr/bin/env bash
# Demo controls for the harness: traffic rate and one-command fault scenarios (AWS FIS experiment templates in HarnessApp).
# Every scenario has a hard duration inside FIS and reverts on its own; `stop` ends one early. Harness only: it never touches
# anything outside cluster `harness` / service `fineract` in this account.
# Usage: demo.sh [--profile <aws profile>] on|off|status|stop|db-outage|slowdown|crash   (default galent-new-dev-1, us-east-1)
set -euo pipefail

PROFILE=galent-new-dev-1
CMD=""
usage() { echo "usage: $0 [--profile <name>] on|off|status|stop|db-outage|slowdown|crash" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || usage; PROFILE="$2"; shift 2 ;;
    on|off|status|stop|db-outage|slowdown|crash) [ -z "$CMD" ] || usage; CMD="$1"; shift ;;
    *) usage ;;
  esac
done
[ -n "$CMD" ] || usage
export AWS_PROFILE="$PROFILE" AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

RATE_PARAM=/harness/traffic/rate_per_min
RATE_ON=60
RATE_OFF=6
SCENARIO_MIN=4       # keep equal to FIS_SCENARIO_DURATION (PT4M) in deploy/cdk/lib/app-stack.ts
# Bounded waits: POLL_MAX polls x POLL_S seconds (default 60 x 15 = 15 min), then a clear error.
POLL_MAX=${POLL_MAX:-60}
POLL_S=${POLL_S:-15}

rate_now() {
  aws ssm get-parameter --name "$RATE_PARAM" --query Parameter.Value --output text 2>/dev/null || echo "unset (traffic uses RATE_PER_MIN, 6)"
}
fineract_counts() { # prints "desired running"
  aws ecs describe-services --cluster harness --services fineract --query 'services[0].desiredCount' --output text
  aws ecs describe-services --cluster harness --services fineract --query 'services[0].runningCount' --output text
}
# Reads the FIS template list on stdin; prints the id of the template tagged harness-scenario=$1.
template_id() {
  python3 -c 'import json,sys
t=[x["id"] for x in json.load(sys.stdin).get("experimentTemplates",[]) if (x.get("tags") or {}).get("harness-scenario")==sys.argv[1]]
print(t[0] if t else "")' "$1"
}
# Lists scenario experiments (identified by the experiment's own harness-scenario tag, which start-experiment sets, so a
# replaced template cannot hide a running one) as "id status startTime scenario", newest first. $1 = all | active
scenario_experiments() {
  local experiments
  experiments=$(aws fis list-experiments --output json)
  python3 -c 'import json,sys
ex=[e for e in json.loads(sys.argv[1]).get("experiments",[]) if (e.get("tags") or {}).get("harness-scenario")]
ex.sort(key=lambda e:str(e.get("startTime","")),reverse=True)
live={"pending","initiating","running","stopping"}
for e in ex:
    st=e.get("state",{}).get("status","?")
    if sys.argv[2]=="active" and st not in live: continue
    print(e["id"],st,e.get("startTime","-"),e["tags"]["harness-scenario"])' "$experiments" "$1"
}
# True when an online SSM managed instance carries the ECS_TASK_ARN tag of Fineract's current task (the FIS sidecar has registered).
fault_agent_ready() {
  local task ids id tags
  task=$(aws ecs list-tasks --cluster harness --service-name fineract --desired-status RUNNING --query 'taskArns[0]' --output text)
  [ -n "$task" ] && [ "$task" != None ] || return 1
  ids=$(aws ssm describe-instance-information --filters Key=ResourceType,Values=ManagedInstance Key=PingStatus,Values=Online \
    --query 'InstanceInformationList[].InstanceId' --output text)
  for id in $ids; do
    tags=$(aws ssm list-tags-for-resource --resource-type ManagedInstance --resource-id "$id" \
      --query "TagList[?Key=='ECS_TASK_ARN'].Value" --output text 2>/dev/null || true)
    [ "$tags" = "$task" ] && return 0
  done
  return 1
}

case "$CMD" in
  on|off)
    new=$RATE_ON; [ "$CMD" = off ] && new=$RATE_OFF
    before=$(rate_now)
    aws ssm put-parameter --name "$RATE_PARAM" --type String --overwrite --value "$new" >/dev/null
    echo "traffic rate per minute: $before -> $new (the traffic task picks it up within about a minute)"
    ;;

  status)
    echo "traffic rate per minute: $(rate_now)"
    read -r desired running <<< "$(fineract_counts | tr '\n' ' ')"
    echo "fineract: $running running / $desired desired"
    echo "active scenario experiments:"
    active=$(scenario_experiments active)
    if [ -n "$active" ]; then printf '%s\n' "$active" | sed 's/^/  /'; else echo "  none"; fi
    echo "recent scenario experiments:"
    recent=$(scenario_experiments all | head -n 5)
    if [ -n "$recent" ]; then printf '%s\n' "$recent" | sed 's/^/  /'; else echo "  none"; fi
    ;;

  stop)
    active=$(scenario_experiments active)
    if [ -z "$active" ]; then echo "no scenario experiment is running"; exit 0; fi
    while read -r id st _ name; do
      [ -n "$id" ] || continue
      if [ "$st" = stopping ]; then echo "$name $id: already stopping"; continue; fi
      aws fis stop-experiment --id "$id" >/dev/null
      echo "stopping $name experiment $id"
    done <<< "$active"
    ;;

  db-outage|slowdown|crash)
    read -r desired running <<< "$(fineract_counts | tr '\n' ' ')"
    if [ "$desired" = "0" ] || [ "$desired" = "None" ]; then
      echo "REFUSED: the harness is paused (fineract desired count 0). Run resume.sh first." >&2; exit 1
    fi
    if [ "$running" -lt 1 ] 2>/dev/null; then
      echo "REFUSED: fineract has no running task ($running running / $desired desired); wait for it to be healthy first." >&2; exit 1
    fi
    active=$(scenario_experiments active)
    if [ -n "$active" ]; then
      echo "REFUSED: a scenario experiment is already running:" >&2; printf '%s\n' "$active" | sed 's/^/  /' >&2
      echo "Wait for it to finish or run: $0 stop" >&2; exit 1
    fi
    if [ "$CMD" != crash ] && ! fault_agent_ready; then
      echo "REFUSED: fault agent still registering (no online SSM instance for Fineract's current task); retry in a minute." >&2
      echo "The agent registers a few minutes after a task starts (after a deploy, resume or crash)." >&2
      exit 1
    fi
    tid=$(aws fis list-experiment-templates --output json | template_id "$CMD")
    [ -n "$tid" ] || { echo "FAILED: no FIS template tagged harness-scenario=$CMD (is HarnessApp deployed with the demo scenarios?)" >&2; exit 1; }

    started=$(date -u +%s)
    out=$(aws fis start-experiment --experiment-template-id "$tid" --tags "harness-scenario=$CMD" --output json)
    exp=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["experiment"]["id"])')
    fmt() { python3 -c 'import datetime,sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]),datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"))' "$1"; }
    echo "scenario:    $CMD"
    echo "experiment:  $exp"
    echo "started:     $(fmt "$started")"
    case "$CMD" in
      db-outage)
        echo "expected end: $(fmt $((started + SCENARIO_MIN * 60))) (hard duration ${SCENARIO_MIN} min, reverts on its own)"
        echo "look for:    Fineract still answers HTTP but API calls return 5xx (database unreachable); traffic journeys start failing." ;;
      slowdown)
        echo "expected end: $(fmt $((started + SCENARIO_MIN * 60))) (hard duration ${SCENARIO_MIN} min, reverts on its own)"
        echo "look for:    about 200 ms added per database round trip; requests still succeed but slow down." ;;
      crash)
        echo "expected end: immediate; ECS then replaces the task (about 7-10 min until Fineract is healthy again)"
        echo "look for:    the Fineract task stops, requests fail until the replacement is up." ;;
    esac

    status=""; poll_fails=0
    for _ in $(seq 1 "$POLL_MAX"); do
      # A flaky poll does not matter (the experiment reverts on its own); give up only after 3 failures in a row.
      if status=$(aws fis get-experiment --id "$exp" --query 'experiment.state.status' --output text 2>/dev/null); then
        poll_fails=0
      else
        poll_fails=$((poll_fails + 1)); status=unknown
        if [ "$poll_fails" -ge 3 ]; then
          echo "FAILED: cannot read experiment $exp ($poll_fails polls in a row); it still ends by itself. Check: $0 status" >&2; exit 1
        fi
      fi
      case "$status" in completed|stopped|failed|cancelled) break ;; esac
      echo "  experiment: $status"; sleep "$POLL_S"
    done
    case "$status" in
      completed|stopped|failed|cancelled) ;;
      *) echo "FAILED: experiment $exp still '$status' after $POLL_MAX polls; check it with: $0 status (stop it with: $0 stop)" >&2; exit 1 ;;
    esac
    reason=$(aws fis get-experiment --id "$exp" --query 'experiment.state.reason' --output text 2>/dev/null || true)
    echo "experiment $exp: $status${reason:+ ($reason)}"
    if [ "$status" = failed ] || [ "$status" = cancelled ]; then
      echo "FAILED: the fault did not run to completion" >&2; exit 1
    fi

    # Final state: Fineract task back to desired.
    [ "$CMD" != crash ] || sleep "$POLL_S"   # let the stop reach ECS before judging the running count
    ok=""
    for _ in $(seq 1 "$POLL_MAX"); do
      read -r desired running <<< "$(fineract_counts | tr '\n' ' ')"
      if [ "$running" = "$desired" ]; then ok=1; break; fi
      echo "  fineract: $running running / $desired desired"; sleep "$POLL_S"
    done
    [ -n "$ok" ] || { echo "FAILED: fineract still $running/$desired after the wait" >&2; exit 1; }
    echo "final: experiment $status; fineract $running running / $desired desired; traffic rate $(rate_now)"
    ;;
esac
