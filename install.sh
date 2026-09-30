#!/bin/sh
# Install sdkvm without a pre-existing Node.js.
# Usage: curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
# Requires a published GitHub Release with sdkvm.tgz and SHA256SUMS.
set -eu

RUNTIME_NODE_VERSION="${SDKVM_RUNTIME_NODE:-22.20.0}"
NODE_DIST="${SDKVM_NODE_DIST:-https://nodejs.org/dist}"
RELEASE_BASE="${SDKVM_RELEASE_BASE:-https://github.com/QInJ1995/sdkvm/releases}"
ROOT="${SDKVM_HOME:-$HOME/.sdkvm}"
BIN_DIR="$ROOT/bin"
NODE_DIST="${NODE_DIST%/}"
RELEASE_BASE="${RELEASE_BASE%/}"
# 控制字符（换行等）会写进损坏的 shim 与 rc 标记块，提前拒绝（install.ps1 同款检查）
case "$ROOT" in
  *[![:print:]]*)
    echo "sdkvm: SDKVM_HOME contains control characters; use a printable path" >&2
    exit 1
    ;;
esac

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Darwin:arm64) node_os=darwin; node_arch=arm64 ;;
  Darwin:x86_64) node_os=darwin; node_arch=x64 ;;
  Linux:x86_64) node_os=linux; node_arch=x64 ;;
  Linux:aarch64|Linux:arm64) node_os=linux; node_arch=arm64 ;;
  *) echo "sdkvm: unsupported platform $os/$arch" >&2; exit 1 ;;
esac

node_name="node-v${RUNTIME_NODE_VERSION}-${node_os}-${node_arch}"
node_archive="${node_name}.tar.gz"
tmpdir=$(mktemp -d)

# 与 CLI（lock.ts）兼容的全局锁：同一 $ROOT/.lock 目录、同样 info.json{pid}。
# 持有者活着就等（有界 60 秒）；pid 已死立即偷（不等 mtime，与 lock.ts 对齐），
# 目录超 5 分钟无心跳也偷——并发的 install.sh 不会互相写坏 runtime/cli，
# `sdkvm upgrade` 也不会撞车 cli.next
LOCK_HELD=0
LOCK_HEARTBEAT_PID=
lock_owner_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}
# 偷锁必须原子（lock.ts stealLock 同款）：先 rename 成自己的暂存名再删。
# 直接 rm -rf + mkdir 的话，两个等待者可以先后删掉彼此刚建的新锁（双持锁）
lock_steal() {
  if mv "$ROOT/.lock" "$ROOT/.lock.stale-$$" 2>/dev/null; then
    rm -rf "$ROOT/.lock.stale-$$"
  fi
}
lock_acquire() {
  # 全新机器 $ROOT 不存在时 mkdir .lock 会因父目录缺失失败，随后读 info 的
  # sed 退出码 2 会把 set -e 的整个脚本无声杀掉——先建根目录
  mkdir -p "$ROOT"
  tries=0
  while :; do
    if mkdir "$ROOT/.lock" 2>/dev/null; then
      printf '{"pid":%s,"startedAt":%s}\n' "$$" "$(date +%s000)" >"$ROOT/.lock/info.json" 2>/dev/null || :
      LOCK_HELD=1
      return 0
    fi
    holder=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/.lock/info.json" 2>/dev/null || :)
    if lock_owner_alive "$holder"; then
      : # 持有者活着：等
    elif [ -n "$holder" ]; then
      # pid 已死：不等 mtime，立即偷（OOM-kill/断电后 5 分钟内也放行安装）
      lock_steal
    elif [ -z "$(find "$ROOT/.lock" -prune -mmin -5 2>/dev/null)" ]; then
      # info.json 缺失且目录超 5 分钟无变动：创建者死在 mkdir 与写 info 之间的无主锁
      lock_steal
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "sdkvm: another sdkvm operation holds $ROOT/.lock; retry in a moment" >&2
      exit 1
    fi
    sleep 1
  done
}
# 只删自己的锁：持锁超过 5 分钟时 CLI 可能已按 stale 把它偷走并转手，
# 无条件 rm -rf 会删掉新持有者的锁
lock_release() {
  if [ "$LOCK_HELD" != 1 ]; then
    return
  fi
  LOCK_HELD=0
  # 与 lock.ts releaseLock 相同：先 rename 再核对 pid。读到自己的 pid 之后直接 rm
  # 会在偷锁窗口删掉新持有者刚建的锁。
  staging="$ROOT/.lock.rel-$$"
  rm -rf "$staging" 2>/dev/null || :
  if mv "$ROOT/.lock" "$staging" 2>/dev/null; then
    holder=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$staging/info.json" 2>/dev/null || :)
    if [ "$holder" = "$$" ]; then
      rm -rf "$staging" 2>/dev/null || :
    else
      mv "$staging" "$ROOT/.lock" 2>/dev/null || :
    fi
  fi
}
# 持锁期间刷新目录 mtime：慢盘/NAS/杀毒扫描让临界区超过 5 分钟时，
# 锁不会被 CLI 按 stale 偷走。子进程里 $$ 仍是主 shell 的 pid
lock_start_heartbeat() {
  (
    while :; do
      sleep 60
      holder=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/.lock/info.json" 2>/dev/null || :)
      [ "$holder" = "$$" ] || break
      touch "$ROOT/.lock" 2>/dev/null || break
    done
  ) &
  LOCK_HEARTBEAT_PID=$!
}
lock_stop_heartbeat() {
  [ -n "$LOCK_HEARTBEAT_PID" ] && kill "$LOCK_HEARTBEAT_PID" 2>/dev/null || :
  LOCK_HEARTBEAT_PID=
}

cleanup() {
  lock_stop_heartbeat
  rm -rf "$tmpdir" 2>/dev/null || :
  lock_release
}
trap cleanup EXIT
# 管道安装（curl | sh）时 SIGPIPE/HUP 常见：必须走 cleanup，否则锁会挂到 stale 才被偷
trap 'cleanup; exit 1' HUP INT TERM

fetch() {
  url=$1
  dest=$2
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL --retry 3 --connect-timeout 15 "$url" -o "$dest"; then
      echo "sdkvm: download failed: $url" >&2
      case "$url" in
        */releases/*/download/*)
          echo "sdkvm: hint: publish a GitHub Release (push a v* tag) with sdkvm.tgz, or install via: npm install -g sdkvm" >&2
          ;;
      esac
      exit 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q --tries=3 --timeout=15 -O "$dest" "$url"; then
      echo "sdkvm: download failed: $url" >&2
      case "$url" in
        */releases/*/download/*)
          echo "sdkvm: hint: publish a GitHub Release (push a v* tag) with sdkvm.tgz, or install via: npm install -g sdkvm" >&2
          ;;
      esac
      exit 1
    fi
  else
    echo "sdkvm: curl or wget is required" >&2
    exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

expect_hash() {
  file=$1
  sums=$2
  awk -v name="$file" '{
    hash = tolower($1)
    file = $2
    sub(/^\*/, "", file)
    if (hash ~ /^[0-9a-f]{64}$/ && file == name) { print hash; exit }
  }' "$sums"
}

# 把路径安全嵌进单引号字符串，供写入 shim
shell_quote() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

echo "sdkvm: downloading Node.js ${RUNTIME_NODE_VERSION} (${node_os}/${node_arch})"
# 归档可以走镜像；校验和固定来自 nodejs.org，避免镜像同时伪造归档和 SHASUMS
OFFICIAL_NODE_DIST="https://nodejs.org/dist"
fetch "${NODE_DIST}/v${RUNTIME_NODE_VERSION}/${node_archive}" "$tmpdir/$node_archive"
fetch "${OFFICIAL_NODE_DIST}/v${RUNTIME_NODE_VERSION}/SHASUMS256.txt" "$tmpdir/SHASUMS256.txt"
expected=$(expect_hash "$node_archive" "$tmpdir/SHASUMS256.txt")
actual=$(sha256_of "$tmpdir/$node_archive")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sdkvm: Node.js checksum mismatch" >&2
  exit 1
fi

echo "sdkvm: downloading CLI"
fetch "${RELEASE_BASE}/latest/download/sdkvm.tgz" "$tmpdir/sdkvm.tgz"
fetch "${RELEASE_BASE}/latest/download/SHA256SUMS" "$tmpdir/SHA256SUMS"
expected=$(expect_hash "sdkvm.tgz" "$tmpdir/SHA256SUMS")
actual=$(sha256_of "$tmpdir/sdkvm.tgz")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sdkvm: CLI checksum mismatch" >&2
  exit 1
fi

lock_acquire
lock_start_heartbeat

mkdir -p "$ROOT/runtime" "$BIN_DIR"
# runtime 先解压到 runtime.next 校验再挪进位：直接解压进 runtime/ 中途失败
# 会留下残缺的 node 目录，shim 一运行就报 loader 错
rm -rf "$ROOT/runtime.next"
mkdir -p "$ROOT/runtime.next"
if ! tar -xzf "$tmpdir/$node_archive" -C "$ROOT/runtime.next" --exclude '*..*'; then
  rm -rf "$ROOT/runtime.next"
  echo "sdkvm: failed to extract the Node.js archive" >&2
  exit 1
fi
if [ ! -x "$ROOT/runtime.next/$node_name/bin/node" ]; then
  rm -rf "$ROOT/runtime.next"
  echo "sdkvm: Node.js archive did not extract $node_name/bin/node" >&2
  exit 1
fi
rm -rf "$ROOT/runtime/$node_name"
mv "$ROOT/runtime.next/$node_name" "$ROOT/runtime/$node_name"
rm -rf "$ROOT/runtime.next"
# current 若是真实目录（历史残留），ln -sfn 会把链接建到目录里面去，先拒绝
if [ -d "$ROOT/runtime/current" ] && [ ! -L "$ROOT/runtime/current" ]; then
  echo "sdkvm: $ROOT/runtime/current is a real directory, not a symlink; remove it and retry" >&2
  exit 1
fi
ln -sfn "$node_name" "$ROOT/runtime/current"

# 原子替换 CLI：先解压并校验，再 rename。cli 不在时 cli.bak 是唯一还能启动的副本，不能先删。
rm -rf "$ROOT/cli.next"
mkdir -p "$ROOT/cli.next"
tar -xzf "$tmpdir/sdkvm.tgz" -C "$ROOT/cli.next" --exclude '*..*'
if [ ! -f "$ROOT/cli.next/package/package.json" ]; then
  echo "sdkvm: release archive missing package/package.json" >&2
  rm -rf "$ROOT/cli.next"
  exit 1
fi
if [ -e "$ROOT/cli" ]; then
  rm -rf "$ROOT/cli.bak"
  mv "$ROOT/cli" "$ROOT/cli.bak"
fi
if ! mv "$ROOT/cli.next/package" "$ROOT/cli"; then
  if [ -e "$ROOT/cli.bak" ] && [ ! -e "$ROOT/cli" ]; then
    mv "$ROOT/cli.bak" "$ROOT/cli"
  fi
  rm -rf "$ROOT/cli.next"
  echo "sdkvm: failed to install CLI package" >&2
  exit 1
fi
rm -rf "$ROOT/cli.next" "$ROOT/cli.bak"

quoted_root=$(shell_quote "$ROOT")
cat > "$BIN_DIR/sdkvm" <<EOF
#!/bin/sh
if [ -n "\${SDKVM_HOME:-}" ]; then
  ROOT="\$SDKVM_HOME"
else
  ROOT='$quoted_root'
fi
exec "\$ROOT/runtime/current/bin/node" "\$ROOT/cli/dist/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/sdkvm"

# PATH：写入 shell rc（标记块，可幂等覆盖）；无法识别 shell 时仅提示
ensure_path_rc() {
  shell_base=$(basename "${SHELL:-}")
  rc=
  case "$shell_base" in
    zsh|-zsh) rc="$HOME/.zshrc" ;;
    bash|-bash)
      case "$(uname -s)" in
        Darwin) rc="$HOME/.bash_profile" ;;
        *) rc="$HOME/.bashrc" ;;
      esac
      ;;
    *) return 1 ;;
  esac

  # rc 是符号链接（dotfiles 管理）时写真实目标，mv 顶掉链接会破坏管理结构
  link_iters=0
  while [ -L "$rc" ]; do
    target=$(readlink "$rc") || { return 1; }
    case "$target" in
      /*) rc=$target ;;
      *) rc=$(dirname "$rc")/$target ;;
    esac
    link_iters=$((link_iters + 1))
    [ "$link_iters" -ge 8 ] && return 1
  done

  # rc 里尽量用 $HOME 相对路径，便于搬家
  case "$BIN_DIR" in
    "$HOME"/*) rel=${BIN_DIR#"$HOME"/}; path_ref="\$HOME/$rel" ;;
    *) rel=$BIN_DIR; path_ref=$BIN_DIR ;;
  esac
  # 路径里出现 " ` $ ' 或换行时无法安全内插进 rc 的 case/export 行
  # （PATH 值会被展开执行）：放弃自动写入，退回手动提示
  nl='
'
  case "$rel" in *"$nl"*) return 1 ;; esac
  if printf '%s' "$rel" | grep -q '["`$'"'"']'; then
    return 1
  fi

  begin='# >>> sdkvm path >>>'
  end='# <<< sdkvm path <<<'
  block=$(printf '%s\n%s\n%s' \
    "$begin" \
    "case \":\$PATH:\" in *\":${path_ref}:\"*) ;; *) export PATH=\"${path_ref}:\$PATH\";; esac" \
    "$end")

  # 注意：本函数在 `if ! ensure_path_rc; then` 的条件上下文里执行，set -e 不生效，
  # 每一步都必须显式检查，绝不能在失败时把 $rc 截断重写
  tmp=$(mktemp) || return 1
  if [ -f "$rc" ]; then
    # 结束标记缺失或带空白时只删起始行，禁止从 begin 跳到文件尾
    awk -v b="$begin" -v e="$end" '
      { sub(/\r$/, ""); lines[++n] = $0 }
      END {
        i = 1
        while (i <= n) {
          line = lines[i]
          gsub(/^[ \t]+|[ \t]+$/, "", line)
          if (line != b) { print lines[i]; i++; continue }
          j = i + 1
          found = 0
          while (j <= n) {
            t = lines[j]
            gsub(/^[ \t]+|[ \t]+$/, "", t)
            if (t == e) { found = 1; break }
            j++
          }
          if (found) i = j + 1
          else i++
        }
      }
    ' "$rc" > "$tmp" || { rm -f "$tmp"; return 1; }
  else
    : > "$tmp" || { rm -f "$tmp"; return 1; }
  fi
  # 先写 $rc.new 再 mv：mv 失败时原 rc 完好无损
  # 行首去 \r 再比对：CRLF 的 rc 里标记行带 \r 不等于 b，旧块剥不掉会重复追加
  if [ -s "$tmp" ]; then
    { cat "$tmp"; printf '\n%s\n' "$block"; } > "$rc.new" || { rm -f "$tmp" "$rc.new"; return 1; }
  else
    printf '%s\n' "$block" > "$rc.new" || { rm -f "$tmp" "$rc.new"; return 1; }
  fi
  mv "$rc.new" "$rc" || { rm -f "$tmp" "$rc.new"; return 1; }
  rm -f "$tmp"
  echo "sdkvm: updated PATH in $rc (open a new terminal or: source $rc)"
  return 0
}

echo "sdkvm: installed to $BIN_DIR/sdkvm"
echo "sdkvm: runtime $ROOT/runtime/current (isolated from sdkvm node use)"
if ! ensure_path_rc; then
  echo "sdkvm: add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
fi
