#!/bin/sh
# ============================================================
# capture-fixtures.sh — 捕获 feishu-notify 的卡片 payload 基线（AC4 黄金样例）
#
# 用法:
#   sh tests/capture-fixtures.sh            # 捕获到临时目录，与已提交 fixtures 逐字节比对（漂移则退出 1）
#   sh tests/capture-fixtures.sh --update   # 重新生成 tests/fixtures/*
#   sh tests/capture-fixtures.sh --help
#
# 机制:
#   - 用 PATH 覆盖 stub 掉 curl（tests 内联生成，不做任何网络请求）。
#     stub 把收到的 -d payload 与目标 URL 分别写文件：payload 逐字节原样，
#     URL **脱敏**为 https://open.feishu.cn/open-apis/bot/v2/hook/<REDACTED>。
#   - **被测脚本自己不再内置地址**（Step 2 起改为调 feishu-notify-cli resolve）。
#     因此这里显式钉住解析输入，否则捕获结果会随"本机配置/环境"漂移：
#       FEISHU_NOTIFY_CLI       = 仓库里的解析器（同目录解析优先，仍显式钉住避免依赖 cwd）
#       FEISHU_NOTIFY_WEBHOOK   = 白名单样例地址 test-fixture-0001（env 优先级高于配置文件）
#       FEISHU_NOTIFY_CONFIG    = 下面生成的固定配置文件 —— **只为了钉住 footer**（见下）
#     webhook 值**不进 payload**，所以 payload 字节与"用哪个地址"无关 —— 这正是 AC4 比对的依据。
#   - footer（R9）也是配置项，而它**会进 payload**（卡片 note）。若不钉住，捕获就会读本机
#     ~/.config/feishu-notify/config.json 里的 `footer: "Smarterlab"`，fixtures 随机器漂移。
#     所以这里把 FEISHU_NOTIFY_CONFIG 指向一个只含中性 footer 的固定配置（**不是** Smarterlab）。
#     webhook 仍由 env 提供（优先级更高），这样 `source=env` 的既有断言逐字不变。
#   - 落盘前把时间戳归一化为 <TIMESTAMP>（脚本里有 2 处：正文 footer 与卡片 note）。
#   - 受控环境：清掉 TERM_PROGRAM/VSCODE_PID/ELECTRON_RUN_AS_NODE/CLAUDE_CODE_DESKTOP（否则
#     "来源" 字段会随终端变化）、把 FEISHU_NOTIFY_CONFIG 指向**本脚本生成的固定配置**（见上，
#     只为了钉住 footer —— 绝不能读本机真实配置）、固定 UTF-8 locale
#     与 PYTHONIOENCODING（脚本用 python3 解析 hook JSON，编码不稳定会让字节漂移）。
#
# 硬性保证:
#   - fixtures 中**绝不**出现真实 webhook；本脚本结束时会对整个输出目录做一次
#     "疑似真实 hook token" 扫描，命中即中止（失败优先于落盘）。
#   - 每组断言 stub **确实收到了 hook 形状的 URL**，避免"因为解析失败退出 2"这种错误原因的假通过。
#   - 时间戳之外的字节完全来自被测脚本，不做任何重写。
# ============================================================
set -eu

MODE="check"
case "${1:-}" in
  --update) MODE="update" ;;
  --check | "") MODE="check" ;;
  --help | -h) sed -n '2,35p' "$0"; exit 0 ;;
  *) echo "未知参数: $1（用 --help）" >&2; exit 1 ;;
esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$ROOT/bin/feishu-notify"
CLI="$ROOT/bin/feishu-notify-cli"
FIXTURES="$ROOT/tests/fixtures"
# 样例地址：test-* 前缀在密钥闸门（lib/secret-scan.mjs）白名单内，不是真实 token
FIXTURE_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/test-fixture-0001"
# 钉住的 footer：用**中性默认值**（不是作者本机的 Smarterlab），R9/AC7 要求默认中性
FIXTURE_FOOTER="feishu-notify"

[ -f "$BIN" ] || { echo "❌ 找不到被测脚本: $BIN" >&2; exit 1; }
[ -x "$CLI" ] || { echo "❌ 找不到可执行的解析器: $CLI" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/feishu-notify-fixtures.XXXXXX")
OUT="$WORK/out"
STUB_DIR="$WORK/bin"
mkdir -p "$OUT" "$STUB_DIR"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------- 钉住 footer 的固定配置 ----------
# 只用于把 footer 钉死在中性值上；webhook 由 env 提供（优先级更高，见文件头说明）。
FIXTURE_CONFIG="$WORK/fixture-config.json"
cat > "$FIXTURE_CONFIG" <<JSON
{
  "version": 1,
  "activeChannel": "default",
  "footer": "$FIXTURE_FOOTER",
  "channels": {
    "default": { "webhook": "$FIXTURE_WEBHOOK" }
  }
}
JSON
chmod 600 "$FIXTURE_CONFIG"

# ---------- 受控环境 ----------
pick_utf8_locale() {
  for candidate in C.UTF-8 en_US.UTF-8 UTF-8 en_US.utf8 zh_CN.UTF-8; do
    if locale -a 2>/dev/null | grep -qx "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf 'C.UTF-8'
}
UTF8_LOCALE=$(pick_utf8_locale)

# ---------- stub curl ----------
cat > "$STUB_DIR/curl" <<'STUB'
#!/bin/sh
# 测试替身：不联网。分别记录 -d payload 与（脱敏的）目标 URL，并伪造 HTTP 200。
set -eu
out=${FEISHU_STUB_OUT:?FEISHU_STUB_OUT not set}
want_payload=0
payload=""
url=""
for arg in "$@"; do
  if [ "$want_payload" = "1" ]; then
    payload=$arg
    want_payload=0
    continue
  fi
  case $arg in
    -d | --data | --data-raw | --data-binary) want_payload=1 ;;
    http://* | https://*) url=$arg ;;
  esac
done

printf '%s' "$payload" > "$out/payload"

case $url in
  *open-apis/bot/v2/hook/*)
    scheme_host=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')
    printf '%s' "$scheme_host/open-apis/bot/v2/hook/<REDACTED>" > "$out/url"
    printf 'hook-shaped' > "$out/url-kind"
    ;;
  '')
    printf '<NO-URL-RECEIVED>' > "$out/url"
    printf 'none' > "$out/url-kind"
    ;;
  *)
    printf '<REDACTED-NON-HOOK-URL>' > "$out/url"
    printf 'other' > "$out/url-kind"
    ;;
esac
printf '200' > "$out/http-code"

# 供人肉排查（不进 fixtures）：
printf 'stub-curl: got payload (%s bytes) -> %s\n' "${#payload}" "$(cat "$out/url")" >&2

# 伪造 curl -w '\n%{http_code}' 的输出形状：body 行 + 末行状态码
printf '%s\n200\n' '{"code":0,"msg":"success"}'
STUB
chmod +x "$STUB_DIR/curl"

# ---------- 输入素材 ----------
printf '%s' '{"last_assistant_message":"多行\n内容"}' > "$WORK/done-stdin.json"
printf '第一行：含"双引号"、反斜杠 \\、制表\t符\n第二行：多行内容\n第三行：emoji ✅\n' > "$WORK/title-file-input.txt"
printf '%s' '{"prompt":"等我决定"}' > "$WORK/idle-stdin.json"

# ---------- 捕获 ----------
RECORDS="$WORK/records.tsv"
: > "$RECORDS"

# run_case <name> <stdin-file> [args...]
run_case() {
  name=$1
  stdin_file=$2
  shift 2

  rm -f "$WORK/payload" "$WORK/url" "$WORK/url-kind" "$WORK/http-code"

  set +e
  env -u TERM_PROGRAM -u VSCODE_PID -u ELECTRON_RUN_AS_NODE -u CLAUDE_CODE_DESKTOP \
    -u FEISHU_NOTIFY_CHANNEL -u FEISHU_NOTIFY_CONFIG_UNDER_TEST \
    LC_ALL="$UTF8_LOCALE" LANG="$UTF8_LOCALE" PYTHONIOENCODING=utf-8 \
    FEISHU_STUB_OUT="$WORK" \
    FEISHU_NOTIFY_CLI="$CLI" \
    FEISHU_NOTIFY_WEBHOOK="$FIXTURE_WEBHOOK" \
    FEISHU_NOTIFY_CONFIG="$FIXTURE_CONFIG" \
    PATH="$STUB_DIR:$PATH" \
    bash "$BIN" "$@" < "$stdin_file" > "$WORK/stdout" 2> "$WORK/stderr"
  code=$?
  set -e

  [ -f "$WORK/payload" ] || {
    echo "❌ $name: stub curl 没收到 payload（退出码 $code）—— 解析失败会走到这里" >&2
    sed 's/^/    stderr: /' "$WORK/stderr" >&2
    exit 1
  }

  # 防止"因为错误原因通过"：必须真的把 hook 形状的地址交给了 curl
  kind=$(cat "$WORK/url-kind" 2>/dev/null || echo none)
  [ "$kind" = "hook-shaped" ] || {
    echo "❌ $name: 目标 URL 不是 hook 形状（kind=$kind, url=$(cat "$WORK/url" 2>/dev/null || echo '<无>')）" >&2
    exit 1
  }

  sed -E 's#[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}#<TIMESTAMP>#g' \
    "$WORK/payload" > "$OUT/$name.payload.json"
  sed -E 's#[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}#<TIMESTAMP>#g' \
    "$WORK/stdout" > "$OUT/$name.stdout.txt"
  cp "$WORK/stderr" "$OUT/$name.stderr.txt"
  cp "$WORK/url" "$OUT/$name.url.txt"

  payload_sha=$(shasum -a 256 < "$OUT/$name.payload.json" | awk '{print $1}')
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$code" "$(cat "$WORK/http-code")" \
    "$payload_sha" "$(cat "$WORK/url")" >> "$RECORDS"

  printf '  %-12s exit=%s http=%s payload=%sB\n' "$name" "$code" "$(cat "$WORK/http-code")" \
    "$(wc -c < "$OUT/$name.payload.json" | tr -d ' ')"
}

echo "▸ 捕获改造前基线（${BIN}）"
run_case idle "$WORK/idle-stdin.json" --idle
run_case done "$WORK/done-stdin.json" --done
run_case title-file "$WORK/title-file-input.txt" --title "T" --file "$WORK/title-file-input.txt"
run_case text /dev/null --text "纯文本"
run_case bare /dev/null "裸文本消息"

# ---------- 退出码 + payload 指纹汇总 ----------
python3 - "$RECORDS" "$OUT/exit-codes.json" <<'PY'
import hashlib, json, pathlib, sys

records = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip().splitlines()
cases = {}
for line in records:
    name, code, http, sha, url = line.split("\t")
    cases[name] = {"exit": int(code), "httpCode": int(http), "payloadSha256": sha, "url": url}

out = {
    "note": "由 tests/capture-fixtures.sh 生成：feishu-notify 改造前（Step 0）行为基线，供 AC4 逐字节回归",
    "payloadSha256": "<case>.payload.json 的 sha256（时间戳已归一化为 <TIMESTAMP>）",
    "cases": cases,
}
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print("  退出码汇总 -> exit-codes.json:", ", ".join(f"{k}=exit{v['exit']}" for k, v in cases.items()))
PY

# ---------- 硬闸门：fixtures 里不允许出现真实 hook token ----------
if grep -rIl -E 'open-apis/bot/v2/hook/[A-Za-z0-9_-]{4,}' "$OUT" 2>/dev/null; then
  echo "❌ 捕获结果中出现疑似真实 hook token，已中止（不落盘）" >&2
  exit 1
fi
echo "  ✓ 已扫描输出目录：无真实 hook token（URL 均为 <REDACTED>）"

# ---------- 落盘 or 比对 ----------
if [ "$MODE" = "update" ]; then
  mkdir -p "$FIXTURES"
  rm -f "$FIXTURES"/*
  cp -p "$OUT"/* "$FIXTURES"/
  echo "✅ 已更新 ${FIXTURES}（$(ls "$FIXTURES" | wc -l | tr -d ' ') 个文件）"
  exit 0
fi

if [ ! -d "$FIXTURES" ] || [ -z "$(ls -A "$FIXTURES" 2>/dev/null)" ]; then
  echo "❌ $FIXTURES 不存在或为空；首次生成请跑: sh tests/capture-fixtures.sh --update" >&2
  exit 1
fi

if diff -r "$FIXTURES" "$OUT"; then
  echo "✅ 与提交的 fixtures 逐字节一致（$(ls "$FIXTURES" | wc -l | tr -d ' ') 个文件）"
else
  echo "❌ fixtures 漂移：上面的 < 是已提交版本，> 是本次捕获" >&2
  exit 1
fi
