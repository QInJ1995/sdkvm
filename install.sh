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
trap 'rm -rf "$tmpdir"' EXIT

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

mkdir -p "$ROOT/runtime" "$BIN_DIR"
rm -rf "$ROOT/runtime/$node_name"
tar -xzf "$tmpdir/$node_archive" -C "$ROOT/runtime"
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

  # rc 里尽量用 $HOME 相对路径，便于搬家
  case "$BIN_DIR" in
    "$HOME"/*) path_ref="\$HOME/${BIN_DIR#"$HOME"/}" ;;
    *) path_ref=$BIN_DIR ;;
  esac

  begin='# >>> sdkvm path >>>'
  end='# <<< sdkvm path <<<'
  block=$(printf '%s\n%s\n%s' \
    "$begin" \
    "case \":\$PATH:\" in *\":${path_ref}:\"*) ;; *) export PATH=\"${path_ref}:\$PATH\";; esac" \
    "$end")

  tmp=$(mktemp)
  if [ -f "$rc" ]; then
    awk -v b="$begin" -v e="$end" '
      $0 == b { skip=1; next }
      skip && $0 == e { skip=0; next }
      !skip { print }
    ' "$rc" > "$tmp"
  else
    : > "$tmp"
  fi
  if [ -s "$tmp" ]; then
    printf '%s\n\n%s\n' "$(cat "$tmp")" "$block" > "$rc"
  else
    printf '%s\n' "$block" > "$rc"
  fi
  rm -f "$tmp"
  echo "sdkvm: updated PATH in $rc (open a new terminal or: source $rc)"
  return 0
}

echo "sdkvm: installed to $BIN_DIR/sdkvm"
echo "sdkvm: runtime $ROOT/runtime/current (isolated from sdkvm node use)"
if ! ensure_path_rc; then
  echo "sdkvm: add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
fi
