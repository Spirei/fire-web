#!/usr/bin/env bash
# Fire 功能冒烟测试：页面、认证、记录 CRUD、数据隔离、实时行情
set -u

BASE="${BASE:-http://localhost:3000}"
JAR_DEMO=$(mktemp)
JAR_NEW=$(mktemp)
PASS=0
FAIL=0
TESTER="tester$(date +%s)"

check() {
  local name="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS  $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $name (expect=$expect got=$actual)"
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

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
check "错误密码被拒绝"      401 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"demo","password":"wrong"}')"

LOGIN=$(curl -s -c "$JAR_DEMO" -w '\n%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"demo","password":"demo1234"}')
check "demo 登录成功" 200 "$(echo "$LOGIN" | tail -1)"
ME=$(curl -s -b "$JAR_DEMO" "$BASE/api/auth/me")
check "me 返回 demo" demo "$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["username"])')"

# 登录后页面巡检：逐页确认服务端渲染没有异常（曾出现 /trading 因 SSR 访问
# localStorage 直接 500 而测试没发现的情况，这里把主要页面都跑一遍）
echo "== 页面巡检（登录后） =="
for PAGE in /holdings /watchlist /fire /global /trading /celebs /earnings /activities /attachments /users /library /settings /asset-analysis /api-docs /deploy-status /simple-app; do
  check "GET ${PAGE}（登录后）" 200 "$(code -b "$JAR_DEMO" "$BASE$PAGE")"
done

# 备份真实设置，测试结束后恢复，避免覆盖用户配置
BACKUP_FILE=$(mktemp)
curl -s -b "$JAR_DEMO" "$BASE/api/settings" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["settings"]))' > "$BACKUP_FILE"
EMAIL_BACKUP=$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["email"])')
NICKNAME_BACKUP=$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["nickname"])')
DEMO_UID=$(echo "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["uid"])')
restore_backup() {
  if [ -s "$BACKUP_FILE" ]; then
    curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw "$(cat "$BACKUP_FILE")" > /dev/null 2>&1 || true
  fi
}
trap restore_backup EXIT

REG=$(curl -s -c "$JAR_NEW" -w '\n%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d "{\"username\":\"$TESTER\",\"password\":\"test1234\",\"isTest\":true}")
check "注册新用户 $TESTER" 201 "$(echo "$REG" | tail -1)"
ME2=$(curl -s -b "$JAR_NEW" "$BASE/api/auth/me")
check "新用户 me 正常" "$TESTER" "$(echo "$ME2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["username"])')"
check "测试账号不占用 UID" 1 "$(echo "$ME2" | python3 -c 'import json,sys; u=json.load(sys.stdin)["user"]; print(1 if not u.get("uid") and u.get("isTest") else 0)')"

echo "== 记录 CRUD =="
check "未登录访问记录 401" 401 "$(code "$BASE/api/records")"
COUNT=$(curl -s -b "$JAR_DEMO" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "demo 有 6 条种子记录" 6 "$COUNT"
COUNT2=$(curl -s -b "$JAR_NEW" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "新用户记录为空（数据隔离）" 0 "$COUNT2"

NEW=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"测试股票","code":"TEST","market":"US","price":100,"cost":80,"qty":10,"group":"测试","note":"API 测试"}')
ID=$(echo "$NEW" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "创建记录成功" "r-" "${ID:0:2}"

PUT=$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/records/$ID" -H 'Content-Type: application/json' -d '{"name":"测试股票改","code":"TEST","market":"US","price":110,"cost":80,"qty":10,"group":"测试","note":"更新成功"}')
check "更新记录价格" 110 "$(echo "$PUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["price"])')"

CROSS=$(code -b "$JAR_NEW" -X PUT "$BASE/api/records/$ID" -H 'Content-Type: application/json' -d '{"name":"越权","code":"X","market":"US","price":1,"cost":1,"qty":1,"group":"","note":""}')
check "新用户无法修改 demo 的记录" 404 "$CROSS"
CROSS_DEL=$(code -b "$JAR_NEW" -X DELETE "$BASE/api/records/$ID")
check "新用户无法删除 demo 的记录" 404 "$CROSS_DEL"

check "删除记录" 200 "$(code -b "$JAR_DEMO" -X DELETE "$BASE/api/records/$ID")"
COUNT3=$(curl -s -b "$JAR_DEMO" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "删除后恢复 6 条" 6 "$COUNT3"

echo "== 批量删除 =="
B1=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"批量A","code":"BA","market":"US","price":10,"cost":8,"qty":1,"group":"","note":""}')
B2=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"批量B","code":"BB","market":"US","price":20,"cost":16,"qty":2,"group":"","note":""}')
ID1=$(echo "$B1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
ID2=$(echo "$B2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
BATCH_BODY="{\"ids\":[\"$ID1\",\"$ID2\"]}"
check "批量删除接口" 200 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/records/batch-delete" -H 'Content-Type: application/json' --data-raw "$BATCH_BODY")"
check "批量删除后记录恢复 6 条" 6 "$(curl -s -b "$JAR_DEMO" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
check "空 ids 被拒绝" 400 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/records/batch-delete" -H 'Content-Type: application/json' --data-raw '{"ids":[]}')"
check "未登录批量删除 401" 401 "$(code -X POST "$BASE/api/records/batch-delete" -H 'Content-Type: application/json' --data-raw '{"ids":["x"]}')"

JP=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"日股测试","code":"7203","market":"JP","price":3000,"cost":2800,"qty":10,"group":"","note":""}')
check "支持日股市场" "JP" "$(echo "$JP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["market"])')"
JPID=$(echo "$JP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -b "$JAR_DEMO" -X DELETE "$BASE/api/records/$JPID"

echo "== 实时行情（腾讯接口） =="
QUOTES=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/quotes" -H 'Content-Type: application/json' -d '{"items":[{"id":"a","market":"CN","code":"600519"},{"id":"b","market":"HK","code":"00700"},{"id":"c","market":"US","code":"AAPL"},{"id":"d","market":"HK","code":"00001"},{"id":"e","market":"CN","code":"BADCODE"}]}')
echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print("  返回行情:", {k: round(v["price"],2) for k,v in d.items()})'
check "行情 A股 贵州茅台"  1 "$(echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print(1 if d.get("a",{}).get("price",0)>0 else 0)')"
check "行情 港股 腾讯"     1 "$(echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print(1 if d.get("b",{}).get("price",0)>0 else 0)')"
check "行情 美股 Apple"    1 "$(echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print(1 if d.get("c",{}).get("price",0)>0 else 0)')"
check "行情 港股 汇丰"     1 "$(echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print(1 if d.get("d",{}).get("price",0)>0 else 0)')"
check "无效代码不返回行情" 0 "$(echo "$QUOTES" | python3 -c 'import json,sys; d=json.load(sys.stdin)["quotes"]; print(1 if "e" in d else 0)')"
check "大盘指数接口（美股指数有值）" 1 "$(curl -s -b "$JAR_DEMO" "$BASE/api/indices" | python3 -c 'import json,sys; gs=json.load(sys.stdin)["groups"]; us=next((g for g in gs if g["market"]=="US"), None); print(1 if us and us["indices"] and us["indices"][0]["latest"] else 0)')"

echo "== 股票搜索联想 =="
check "未登录搜索可用（访客自选）" 1 "$(curl -s "$BASE/api/search?q=AAPL" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print(1 if any(x["name"]=="苹果" for x in r) else 0)')"
SEARCH_TX=$(curl -G -s -b "$JAR_DEMO" --data-urlencode "q=腾讯" "$BASE/api/search")
check "搜「腾讯」返回腾讯控股" 1 "$(echo "$SEARCH_TX" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print(1 if any(x["name"]=="腾讯控股" and x["market"]=="HK" and x["price"] and x["price"]>0 for x in r) else 0)')"
SEARCH_AAPL=$(curl -G -s -b "$JAR_DEMO" --data-urlencode "q=AAPL" "$BASE/api/search")
check "搜「AAPL」返回苹果" 1 "$(echo "$SEARCH_AAPL" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print(1 if any(x["name"]=="苹果" and x["market"]=="US" and x["price"] and x["price"]>0 for x in r) else 0)')"
SEARCH_MAOTAI=$(curl -G -s -b "$JAR_DEMO" --data-urlencode "q=600519" "$BASE/api/search")
check "搜「600519」返回贵州茅台" 1 "$(echo "$SEARCH_MAOTAI" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print(1 if any(x["name"]=="贵州茅台" and x["market"]=="CN" for x in r) else 0)')"

echo "== 账户日志 =="
ACT=$(curl -s -b "$JAR_DEMO" "$BASE/api/activities")
check "demo 有账户日志" 1 "$(echo "$ACT" | python3 -c 'import json,sys; print(1 if len(json.load(sys.stdin).get("userLogs") or [])>0 else 0)')"
check "账户日志含事件和操作人" 1 "$(echo "$ACT" | python3 -c 'import json,sys; a=(json.load(sys.stdin).get("userLogs") or [{}])[0]; print(1 if a.get("event") and a.get("userName") else 0)')"

echo "== 修改密码 =="
check "原密码错误被拒绝" 400 "$(code -b "$JAR_NEW" -X POST "$BASE/api/auth/password" -H 'Content-Type: application/json' -d '{"oldPassword":"wrong","newPassword":"newpass123"}')"
check "修改密码成功" 200 "$(code -b "$JAR_NEW" -X POST "$BASE/api/auth/password" -H 'Content-Type: application/json' -d '{"oldPassword":"test1234","newPassword":"newpass1234"}')"
LOGIN_NEW_BODY="{\"username\":\"$TESTER\",\"password\":\"newpass1234\"}"
LOGIN_OLD_BODY="{\"username\":\"$TESTER\",\"password\":\"test1234\"}"
check "新密码可登录" 200 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-raw "$LOGIN_NEW_BODY")"
check "旧密码已失效" 401 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-raw "$LOGIN_OLD_BODY")"

echo "== 清空全部记录 =="
NEW2=$(curl -s -b "$JAR_NEW" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"待清理","code":"CLR","market":"US","price":10,"cost":8,"qty":5,"group":"测试","note":""}')
check "测试账号创建记录" "r-" "$(echo "$NEW2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"][:2])')"
ACT2=$(curl -s -b "$JAR_NEW" "$BASE/api/activities")
check "测试账号有账户日志" 1 "$(echo "$ACT2" | python3 -c 'import json,sys; print(1 if len(json.load(sys.stdin).get("userLogs") or [])>0 else 0)')"
CLEAR=$(curl -s -b "$JAR_NEW" -X DELETE "$BASE/api/records" -H 'Content-Type: application/json' --data-raw '{"password":"newpass1234"}')
check "清空记录接口" 200 "$(echo "$CLEAR" | python3 -c 'import json,sys; print(200 if json.load(sys.stdin).get("ok") else 0)')"
COUNT4=$(curl -s -b "$JAR_NEW" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "清空后记录=0" 0 "$COUNT4"
ACT3=$(curl -s -b "$JAR_NEW" "$BASE/api/activities")
check "清空持仓写入审计日志" 1 "$(echo "$ACT3" | python3 -c 'import json,sys; print(1 if any(x.get("event")=="records_clear" for x in (json.load(sys.stdin).get("userLogs") or [])) else 0)')"
COUNT5=$(curl -s -b "$JAR_DEMO" "$BASE/api/records" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "demo 数据不受影响" 6 "$COUNT5"

echo "== 个人资料与头像上传 =="
python3 -c "import base64; open('/tmp/smoke-avatar.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))"
AVATAR=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/upload" -F "kind=avatar" -F "file=@/tmp/smoke-avatar.png;type=image/png")
check "头像上传成功" "/uploads/avatar/" "$(echo "$AVATAR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"][:16])')"
ME_AVATAR=$(curl -s -b "$JAR_DEMO" "$BASE/api/auth/me")
check "me 返回头像地址" "/uploads/avatar/" "$(echo "$ME_AVATAR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["avatar"][:16])')"
check "非法文件类型被拒" 400 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/upload" -F "kind=avatar" -F "file=@scripts/smoke-test.sh;type=text/plain")"
dd if=/dev/zero of=/tmp/smoke-big.png bs=1024 count=1100 2>/dev/null
check "超过 1024KB 头像被拒" 400 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/upload" -F "kind=avatar" -F "file=@/tmp/smoke-big.png;type=image/png")"
check "未登录不能上传" 401 "$(code -X POST "$BASE/api/upload" -F "kind=avatar" -F "file=@/tmp/smoke-avatar.png;type=image/png")"
PROFILE_BODY='{"username":"demo","email":"demo-new@fire.local","currentPassword":"demo1234"}'
check "更新个人邮箱" "demo-new@fire.local" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/auth/profile" -H 'Content-Type: application/json' --data-raw "$PROFILE_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["email"])')"
check "邮箱格式校验" 400 "$(code -b "$JAR_DEMO" -X PUT "$BASE/api/auth/profile" -H 'Content-Type: application/json' --data-raw '{"email":"bad-email"}')"

echo "== 用户管理 =="
USERS=$(curl -s -b "$JAR_DEMO" "$BASE/api/users")
check "用户列表包含 demo" 1 "$(echo "$USERS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(1 if any(u["username"]=="demo" for u in d["users"]) else 0)')"
check "demo 是管理员" "admin" "$(echo "$USERS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([u["role"] for u in d["users"] if u["username"]=="demo"][0])')"
TID=$(echo "$USERS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([u["id"] for u in d["users"] if u["username"]=="'"$TESTER"'"][0])')
check "用户列表标记测试账号" 1 "$(echo "$USERS" | python3 -c 'import json,sys; d=json.load(sys.stdin); u=[u for u in d["users"] if u["username"]=="'"$TESTER"'"][0]; print(1 if u.get("isTest") and not u.get("uid") else 0)')"
EDIT_BODY="{\"email\":\"$TESTER@test.local\",\"role\":\"user\"}"
check "编辑用户邮箱" "$TESTER@test.local" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/users/$TID" -H 'Content-Type: application/json' --data-raw "$EDIT_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["email"])')"
check "重置用户密码" 200 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/users/$TID/reset-password" -H 'Content-Type: application/json' --data-raw '{"newPassword":"reset123"}')"
RESET_LOGIN_BODY="{\"username\":\"$TESTER\",\"password\":\"reset123\"}"
check "重置后新密码可登录" 200 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' --data-raw "$RESET_LOGIN_BODY")"
check "不能删除自己" 400 "$(code -b "$JAR_DEMO" -X DELETE "$BASE/api/users/demo-user")"
check "删除用户" 200 "$(code -b "$JAR_DEMO" -X DELETE "$BASE/api/users/$TID")"
check "删除后列表不存在" 0 "$(curl -s -b "$JAR_DEMO" "$BASE/api/users" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(1 if any(u["id"]=="'"$TID"'" for u in d["users"]) else 0)')"

echo "== 网站设置 =="
check "公共设置接口（无需登录）" 200 "$(code "$BASE/api/settings/public")"
SETTINGS=$(curl -s -b "$JAR_DEMO" "$BASE/api/settings")
check "标题字段存在" 1 "$(echo "$SETTINGS" | python3 -c 'import json,sys; print(1 if len(json.load(sys.stdin)["settings"]["title"])>0 else 0)')"
# 注意：不要改动 ico/homepageBg/siteLogo —— 站点形象替换会触发删旧文件，测试写占位路径会误删用户真实文件
HOME_TITLE=$(curl -s "$BASE/" | grep -o "<title>[^<]*" | head -1 | sed 's/<title>//')
EXPECTED_TITLE=$(python3 -c "import json; print(json.load(open('$BACKUP_FILE'))['title'])")
check "首页标题与站点设置一致" "$EXPECTED_TITLE" "$HOME_TITLE"

echo "== 数据库增强 =="
check "SQLite 状态接口" "sqlite" "$(curl -s -b "$JAR_DEMO" "$BASE/api/db/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"]["type"])')"
PG_BODY='{"dbType":"postgres","pgHost":"db.example.com","pgPort":"5432","pgDatabase":"fire","pgUser":"admin","pgPassword":"secret"}'
check "保存 PostgreSQL 配置" "postgres" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw "$PG_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["dbType"])')"
check "连接测试（不可达返回错误）" 400 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/db/test" -H 'Content-Type: application/json' --data-raw '{"host":"127.0.0.1","port":1,"database":"x","pgUser":"x","password":"x"}')"
check "还原 SQLite 类型" "sqlite" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"dbType":"sqlite","pgHost":"","pgPort":"5432","pgDatabase":"","pgUser":"","pgPassword":""}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["dbType"])')"

echo "== 分组管理（全局改名） =="
GRP=$(curl -s -b "$JAR_DEMO" -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d '{"name":"分组测试","code":"GRP","market":"US","price":10,"cost":9,"qty":1,"group":"旧分组","note":""}')
GRPID=$(echo "$GRP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"groups":[{"id":"g1","name":"旧分组"}]}'
check "保存分组列表并改名" "新分组" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"groups":[{"id":"g1","name":"新分组"}]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["groups"][0]["name"])')"
check "分组改名全局同步到记录" "新分组" "$(curl -s -b "$JAR_DEMO" "$BASE/api/records" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([r["group"] for r in d if r["id"]=="'"$GRPID"'"][0])')"
curl -s -o /dev/null -b "$JAR_DEMO" -X DELETE "$BASE/api/records/$GRPID"

echo "== 市场顺序配置 =="
check "保存市场顺序" "JP" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"markets":["US","JP"]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["markets"][1])')"
check "保存市场自定义名称" "美股精选" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"markets":["US","JP"],"marketLabels":[{"key":"US","label":"美股精选"}]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["marketLabels"][0]["label"])')"
check "新增自定义市场键" "SG" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"markets":["US","JP","SG"],"marketLabels":[{"key":"SG","label":"新加坡","flag":"🇸🇬"}]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["markets"][2])')"
check "自定义市场标签与国旗" "🇸🇬 新加坡" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/settings" -H 'Content-Type: application/json' --data-raw '{"markets":["US","JP","SG"],"marketLabels":[{"key":"SG","label":"新加坡","flag":"🇸🇬"}]}' | python3 -c 'import json,sys; s=json.load(sys.stdin)["settings"]; print(s["marketLabels"][0]["flag"]+" "+s["marketLabels"][0]["label"])')"
check "美股财报接口" 200 "$(code "$BASE/api/earnings")"

echo "== 测试数据还原 =="
restore_backup
RESTORED_TITLE=$(curl -s -b "$JAR_DEMO" "$BASE/api/settings" | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["title"])')
BACKUP_TITLE=$(python3 -c "import json; print(json.load(open('$BACKUP_FILE'))['title'])")
check "还原网站设置（与备份一致）" "$BACKUP_TITLE" "$RESTORED_TITLE"
RESTORE_PROFILE_BODY="{\"username\":\"demo\",\"email\":\"$EMAIL_BACKUP\",\"nickname\":\"$NICKNAME_BACKUP\",\"currentPassword\":\"demo1234\"}"
check "还原 demo 邮箱" "$EMAIL_BACKUP" "$(curl -s -b "$JAR_DEMO" -X PUT "$BASE/api/auth/profile" -H 'Content-Type: application/json' --data-raw "$RESTORE_PROFILE_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["email"])')"
python3 -c "import sqlite3; db=sqlite3.connect('data/fire.db'); db.execute(\"UPDATE users SET avatar='' WHERE id='demo-user'\"); db.commit()"

echo "== 退出登录 =="
check "退出登录成功" 200 "$(code -b "$JAR_DEMO" -X POST "$BASE/api/auth/logout")"
check "退出后 me 返回 401" 401 "$(code -b "$JAR_DEMO" "$BASE/api/auth/me")"

echo ""
echo "测试结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
