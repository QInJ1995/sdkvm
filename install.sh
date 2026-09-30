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
# 持有者活着就等（有界 60 秒）；pid 已死或目录 5 分钟没心跳则按 stale 偷掉——
# 并发的 install.sh 不会互相写坏 runtime/cli，`sdkvm upgrade` 也不会撞车 cli.next
LOCK_HELD=0
lock_acquire() {
  tries=0
  while :; do
    if mkdir "$ROOT/.lock" 2>/dev/null; then
      printf '{"pid":%s,"startedAt":%s}\n' "$$" "$(date +%s000)" >"$ROOT/.lock/info.json" 2>/dev/null || :
      LOCK_HELD=1
      return 0
    fi
    holder=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/.lock/info.json" 2>/dev/null)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      : # 持有者活着：等
    elif [ -z "$(find "$ROOT/.lock" -prune -mmin -5 2>/dev/null)" ]; then
      rm -rf "$ROOT/.lock" && continue # stale：偷锁后重试 mkdir
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "sdkvm: another sdkvm operation holds $ROOT/.lock; retry in a moment" >&2
      exit 1
    fi
    sleep 1
  done
}
lock_release() {
  if [ "$LOCK_HELD" = 1 ]; then
    rm -rf "$ROOT/.lock" 2>/dev/null || :
    LOCK_HELD=0
  fi
}

cleanup() {
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
fetch "${NODE_DIST}/v${RUNTIME_NODE_VERSION}/${node_archive}" "$tmpdir/$node_archive"
fetch "${NODE_DIST}/v${RUNTIME_NODE_VERSION}/SHASUMS256.txt" "$tmpdir/SHASUMS256.txt"
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

mkdir -p "$ROOT/runtime" "$BIN_DIR"
# runtime 先解压到 runtime.next 校验再挪进位：直接解压进 runtime/ 中途失败
# 会留下残缺的 node 目录，shim 一运行就报 loader 错
rm -rf "$ROOT/runtime.next"
mkdir -p "$ROOT/runtime.next"
if ! tar -xzf "$tmpdir/$node_archive" -C "$ROOT/runtime.next"; then
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

# 原子替换 CLI：先解压并校验，再 rename；失败时保留旧 cli
rm -rf "$ROOT/cli.next" "$ROOT/cli.bak"
mkdir -p "$ROOT/cli.next"
tar -xzf "$tmpdir/sdkvm.tgz" -C "$ROOT/cli.next"
if [ ! -f "$ROOT/cli.next/package/package.json" ]; then
  echo "sdkvm: release archive missing package/package.json" >&2
  rm -rf "$ROOT/cli.next"
  exit 1
fi
if [ -e "$ROOT/cli" ]; then
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
    awk -v b="$begin" -v e="$end" '
      { sub(/\r$/, "") }
      $0 == b { skip=1; next }
      skip && $0 == e { skip=0; next }
      !skip { print }
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
