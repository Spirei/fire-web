#!/usr/bin/env bash
# 使用独立测试账号做只读巡检；业务写入回归由 npm run test:review 的临时数据库完成。
set -u

BASE="${BASE:-http://localhost:3000}"
JAR_ACCOUNT=$(mktemp)
LOGIN_BODY=$(mktemp)
WRONG_BODY=$(mktemp)
PASS=0
FAIL=0
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BASE
trap 'rm -f "$JAR_ACCOUNT" "$LOGIN_BODY" "$WRONG_BODY"' EXIT
SMOKE_USERNAME=$(node "$SCRIPT_ROOT/scripts/smoke-account.mjs" --login-body "$LOGIN_BODY" --wrong-body "$WRONG_BODY") || exit 1

check() {
  local name="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS  $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $name (expect=$expect got=$actual)"
  fi
}

code() { curl -s --max-time 45 -o /dev/null -w '%{http_code}' "$@"; }

echo "== 页面加载 =="
check "GET /"          200 "$(code "$BASE/")"
check "GET /login"     200 "$(code "$BASE/login")"
check "GET /api/auth/setup-status" 200 "$(code "$BASE/api/auth/setup-status")"
check "已初始化实例不需要首次设置" 0 "$(curl -s "$BASE/api/auth/setup-status" | python3 -c 'import json,sys; print(1 if json.load(sys.stdin).get("needsSetup") else 0)')"
check "GET /setup 已初始化则跳转" 307 "$(code "$BASE/setup")"
check "GET /records 重定向默认页" 307 "$(code "$BASE/records")"
REDIRECT_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/records")
check "默认页未登录跳转登录" 307 "$(code "${REDIRECT_LOC:-$BASE/holdings}")"
LOGIN_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "${REDIRECT_LOC:-$BASE/holdings}")
check "跳转目标为登录页" 1 "$(echo "$LOGIN_LOC" | grep -c '/login')"

echo "== 认证 =="
check "me 未登录返回 401" 401 "$(code "$BASE/api/auth/me")"
check "股票池未登录拒绝" 401 "$(code "$BASE/api/quote-pool")"
check "请求日志未登录拒绝" 401 "$(code "$BASE/api/request-logs")"
check "请求日志实时订阅未登录拒绝" 401 "$(code "$BASE/api/request-logs/events")"
check "错误密码被拒绝"      401 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-binary "@$WRONG_BODY")"

LOGIN=$(curl -s -c "$JAR_ACCOUNT" -w '\n%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-binary "@$LOGIN_BODY")
LOGIN_CODE=$(echo "$LOGIN" | tail -1)
check "独立测试账号登录成功" 200 "$LOGIN_CODE"
if [ "$LOGIN_CODE" != 200 ]; then
  echo "独立测试账号登录失败，停止巡检；不会修改或重置任何账号密码。"
  exit 1
fi
ME=$(curl -s -b "$JAR_ACCOUNT" "$BASE/api/auth/me")
check "me 返回独立测试账号" "$SMOKE_USERNAME" "$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["username"])')"
ACCOUNT_ROLE=$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["role"])')
if [ "$ACCOUNT_ROLE" != admin ]; then
  check "普通用户请求日志拒绝" 403 "$(code -b "$JAR_ACCOUNT" "$BASE/api/request-logs")"
  check "普通用户实时订阅拒绝" 403 "$(code -b "$JAR_ACCOUNT" "$BASE/api/request-logs/events")"
else
  check "管理员请求日志读取" 200 "$(code -b "$JAR_ACCOUNT" "$BASE/api/request-logs")"
fi
# 登录后页面巡检：逐页确认服务端渲染没有异常（曾出现 /trading 因 SSR 访问
# localStorage 直接 500 而测试没发现的情况，这里把主要页面都跑一遍）
echo "== 页面巡检（登录后） =="
for PAGE in /holdings /watchlist /fire /global /trading /celebs /earnings /activities /attachments /users /library /cards /settings /asset-analysis /api-docs /api-requests /simple-app; do
  check "GET ${PAGE}（登录后）" 200 "$(code -b "$JAR_ACCOUNT" "$BASE$PAGE")"
done
DEPLOY_STATUS_EXPECT=404
if [ "$ACCOUNT_ROLE" = admin ]; then DEPLOY_STATUS_EXPECT=200; fi
check "部署状态页按账号权限访问" "$DEPLOY_STATUS_EXPECT" "$(code -b "$JAR_ACCOUNT" "$BASE/deploy-status")"

check "股票池页面登录读取" 200 "$(code -b "$JAR_ACCOUNT" "$BASE/quote-pool")"
check "本人股票池登录读取" 200 "$(code -b "$JAR_ACCOUNT" "$BASE/api/quote-pool?scope=mine")"
SHARED_POOL_EXPECT=403
if [ "$ACCOUNT_ROLE" = admin ]; then SHARED_POOL_EXPECT=200; fi
check "共享股票池按账号权限访问" "$SHARED_POOL_EXPECT" "$(code -b "$JAR_ACCOUNT" "$BASE/api/quote-pool?scope=shared")"

# 公开数据接口：交易广场 / 行情 / 分时 / 汇率（交易广场页面曾整页 500，接口也要有兜底检查）
echo "== 公开数据接口 =="
for API in /api/trading-square/feed /api/trading-square/duan /api/trading-square/trump; do
  check "GET ${API}" 200 "$(code "$BASE$API")"
done
check "行情接口（未登录可用）" 200 "$(code -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d '{"items":[{"id":"US:AAPL","market":"US","code":"AAPL"}]}')"
check "行情接口返回价格" 1 "$(curl -s --max-time 40 -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d '{"items":[{"id":"US:AAPL","market":"US","code":"AAPL"}]}' | python3 -c 'import json,sys; q=(json.load(sys.stdin).get("quotes") or {}).get("US:AAPL") or {}; print(1 if isinstance(q.get("price"), (int,float)) and q["price"] > 0 else 0)')"
JP_KR_BODY='{"items":[{"id":"JP:7203","market":"JP","code":"7203"},{"id":"KR:005930","market":"KR","code":"005930"}]}'
check "日韩行情接口 HTTP" 200 "$(code --max-time 40 -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d "$JP_KR_BODY")"
JP_KR_JSON=$(curl -s --max-time 40 -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d "$JP_KR_BODY")
check "日股 7203 有现价" 1 "$(echo "$JP_KR_JSON" | python3 -c 'import json,sys; q=(json.load(sys.stdin).get("quotes") or {}).get("JP:7203") or {}; print(1 if isinstance(q.get("price"), (int,float)) and q["price"] > 0 else 0)')"
check "韩股 005930 有现价" 1 "$(echo "$JP_KR_JSON" | python3 -c 'import json,sys; q=(json.load(sys.stdin).get("quotes") or {}).get("KR:005930") or {}; print(1 if isinstance(q.get("price"), (int,float)) and q["price"] > 0 else 0)')"
check "美股五日分时接口" 200 "$(code --max-time 40 "$BASE/api/kline/five-day?code=AAPL&market=US")"
check "个股详情接口" 200 "$(code --max-time 40 "$BASE/api/v1/stock-detail?market=US&code=AAPL")"
check "汇率接口（登录后）" 200 "$(code -b "$JAR_ACCOUNT" "$BASE/api/rates")"
check "汇率以美元为基准" 1 "$(curl -s -b "$JAR_ACCOUNT" "$BASE/api/rates" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("rates") or {}; print(1 if r.get("USD")==1 else 0)')"

for API in /api/records /api/activities /api/settings /api/cards/holdings /api/cards/amounts /api/cards/wallet; do
  check "${API} 未登录拒绝" 401 "$(code "$BASE$API")"
  check "${API} 登录读取" 200 "$(code -b "$JAR_ACCOUNT" "$BASE$API")"
done
check "资金分页小数参数" 200 "$(code -b "$JAR_ACCOUNT" "$BASE/api/v1/funds?recordsOnly=1&limit=1.5&offset=0.5")"
check "退出测试会话" 200 "$(code -b "$JAR_ACCOUNT" -X POST "$BASE/api/auth/logout" -H "Origin: $BASE")"
echo "只读巡检结果: PASS=${PASS} FAIL=${FAIL}；写入回归使用 npm run test:review 的临时数据库。"
[ "$FAIL" -eq 0 ]
exit $?
