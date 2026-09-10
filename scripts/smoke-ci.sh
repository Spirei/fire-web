#!/usr/bin/env bash
# CI / 钩子用的短冒烟：不依赖 demo 账号，只检查页面与公开接口能起来。
set -u

BASE="${BASE:-http://127.0.0.1:3000}"
PASS=0
FAIL=0

check() {
  local name="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS  $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $name (expect=$expect got=$actual)"
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== CI 短冒烟 ${BASE} =="
check "GET /" 200 "$(code --max-time 20 "$BASE/")"
check "GET /login" 200 "$(code --max-time 20 "$BASE/login")"
check "GET /api/auth/setup-status" 200 "$(code --max-time 20 "$BASE/api/auth/setup-status")"
check "GET /api/health" 200 "$(code --max-time 20 "$BASE/api/health")"
check "GET /api/trading-square/feed" 200 "$(code --max-time 30 "$BASE/api/trading-square/feed")"

QUOTE_BODY='{"items":[{"id":"US:AAPL","market":"US","code":"AAPL"},{"id":"JP:7203","market":"JP","code":"7203"},{"id":"KR:005930","market":"KR","code":"005930"}]}'
check "行情接口 HTTP" 200 "$(code --max-time 40 -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d "$QUOTE_BODY")"
QUOTE_JSON=$(curl -s --max-time 40 -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d "$QUOTE_BODY")
priced() {
  local key="$1"
  printf '%s' "$QUOTE_JSON" | python3 -c 'import json,sys; q=(json.load(sys.stdin).get("quotes") or {}).get(sys.argv[1]) or {}; print(1 if isinstance(q.get("price"), (int,float)) and q["price"]>0 else 0)' "$key" 2>/dev/null || echo 0
}
check "美股 AAPL 有现价" 1 "$(priced US:AAPL)"
check "日股 7203 有现价" 1 "$(priced JP:7203)"
check "韩股 005930 有现价" 1 "$(priced KR:005930)"

echo
echo "CI 冒烟结果：PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
