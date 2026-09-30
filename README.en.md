<div align="center">

# sdkvm

**A cross-platform version manager for language SDKs**

[![npm version](https://img.shields.io/npm/v/sdkvm)](https://www.npmjs.com/package/sdkvm)
[![CI](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml/badge.svg)](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/sdkvm)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-green)](./package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#requirements)

[中文](./README.md) | English

Install, switch, and remove **Java JDKs**, **Go toolchains**, the **Flutter SDK**,
the **Node.js runtime**, **Apache Maven**, **Miniconda**, and **CPython** from one CLI.

</div>

---

## Contents

- [Overview](#overview)
- [Highlights](#highlights)
- [Supported SDKs](#supported-sdks)
- [Requirements](#requirements)
- [Install](#install)
- [Upgrading the CLI](#upgrading-the-cli)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Version specification](#version-specification)
- [Exit codes](#exit-codes)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Mirrors and registries](#mirrors-and-registries)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Development](#development)
- [License](#license)

## Overview

`sdkvm` is a Node.js CLI that manages multiple language SDKs from one place: it
resolves, downloads, verifies, and installs SDKs from official sources or
mirrors, and switches versions by retargeting a single symlink. Installed trees
are never moved, and nothing is written outside sdkvm's own data root and a
small set of marked shell-init or user-environment entries.

Design goals:

- **Isolation.** Every version lives under one data root (default `~/.sdkvm`),
  with one directory tree, one `current-*` link, and one set of environment
  variables per SDK. Multiple versions coexist without interfering.
- **Reversibility.** Host changes are minimal: a marked init block in the shell
  rc on macOS / Linux, user-level environment variables on Windows. Everything
  sdkvm writes can be removed precisely.
- **Reliability.** Hashes are computed while archives stream in, mirrors and
  installers are strictly verified, installs land atomically, failures leave no
  partial state, and concurrent processes are serialized by a file lock.
- **Extensibility.** Adding a language means implementing one vendor module;
  `install` / `use` / `ls` / `uninstall` / `mirror` plus rc and registry
  writes follow automatically.

## Highlights

- Seven SDK types and three JDK distributions (Temurin / Zulu / Corretto) behind one interface.
- One version-spec grammar — `lts`, `latest`, major lines, exact versions, and
  vendor prefixes — shared by `install`, `use`, and `uninstall`; `v` / `go`
  prefixes are tolerated, so you can paste `node --version` / `go version` output.
- Cross-platform: macOS (Apple Silicon / Intel), mainstream Linux (x64 / aarch64),
  and Windows 10+ with junctions and `REG_EXPAND_SZ` user variables (no `setx` truncation).
- Integrity: SHA-256 streamed during download and compared against official
  manifests; expected hashes are only taken from official sources — mirror-hosted
  sidecar files are controlled by the same mirror as the archive, so they never
  define the expectation; mirrored downloads and executable installers require an
  officially verifiable hash or fail **before** downloading. Maven verifies the
  official SHA-512 (SHA-1 for old releases).
- Download acceleration: built-in mirror sites (nju / tuna / aliyun / huawei /
  ustc) configured per SDK type, plus independent npm-registry (`nrm`) and
  Maven dependency-mirror (`mrm`) managers.
- Atomic installs: extract and validate in a temp directory, then move into
  place once; checksum failures and interruptions leave no residue. Installer
  archives (Miniconda) are tracked with an `.incomplete` marker, so a hard-killed
  install is recovered or cleaned up automatically on the next run.
- Concurrency safety: installs, switches, removals, and upgrades share an
  exclusive file lock with PID liveness checks and heartbeats; crashed holders
  are recovered automatically.
- No preinstalled Node.js required: the official install script ships an
  isolated runtime, with data and entrypoints under `SDKVM_HOME`.

## Supported SDKs

| SDK | Source | Version support | Notes |
| --- | --- | --- | --- |
| Java | [Temurin](https://adoptium.net/), [Zulu](https://www.azul.com/downloads/), [Corretto](https://aws.amazon.com/corretto/) | `lts` is currently 8 / 11 / 17 / 21 / 25; exact versions and `+build` | All three distributions coexist; `use` can switch across vendors; Corretto publishes LTS lines only; on Linux, Zulu, Temurin, and Corretto match the host libc — glibc hosts get glibc builds, Alpine/musl hosts get the official musl or alpine builds |
| Go | [go.dev/dl](https://go.dev/dl/) | every historical stable release | `latest`, `1.24`, `1.24.5` |
| Flutter | official release manifest | stable / beta | both macOS architectures; Linux / Windows are x64 only; beta needs the full prerelease |
| Node.js | [nodejs.org/dist](https://nodejs.org/dist) | `lts` (currently 24 Krypton) / `latest` / major line / exact | npm switches together with the runtime |
| Maven | [Maven Central](https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/) | all stable releases from 3.0; prereleases by exact version | no `lts` alias |
| Miniconda | [repo.anaconda.com/miniconda](https://repo.anaconda.com/miniconda/) | `26` / `26.7` / `py313` / `py313_26.7.1-1` / `latest` | installer is about 150 MB; a silent install accepts the [Miniconda terms](https://www.anaconda.com/legal) |
| Python | [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | `3` / `3.12` / `3.12.7` / `3.14.0rc2` / `latest` | prebuilt CPython, archive about 20–40 MB; independent of Miniconda |

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | >= 18.17 | Required for the npm install method. The install script ships an isolated runtime |
| OS | — | macOS (Apple Silicon / Intel), mainstream Linux, Windows 10+ |
| Extractor | built in | `tar` on macOS / Linux; Windows uses bsdtar, falling back to PowerShell `Expand-Archive` |

Platform limits:

- Extracting Flutter (`.tar.xz`) on Linux requires `xz` (`xz-utils`); mainstream
  distributions include it.
- Official Flutter archives for Linux and Windows are x64 only; ARM Linux and
  ARM Windows cannot install Flutter. Both macOS architectures are supported.
- The first `flutter` run builds an internal cache; that wait is expected.
- Miniconda: the Windows install path cannot contain spaces (point `SDKVM_HOME`
  at a space-free path if needed); Windows is x64 only, macOS supports both
  architectures, and Linux supports x64 and aarch64. Newer releases may publish
  only some of those platforms. An installer runs only after its SHA-256 checks
  out, mirrored or not.
- Python uses the python-build-standalone `install_only_stripped` archive
  (falling back to `install_only`) covering x64 and aarch64 on all three
  systems. Free-threaded and musl builds and the `x86_64_v2` / `v3` / `v4`
  variants are not installed. The list reflects the latest build snapshot; an
  exact version missing there is looked up in the most recent release tags.

## Install

### Install script (recommended)

No preinstalled Node.js needed: the script downloads an isolated runtime used
only by the CLI, and keeps all data and entrypoints under `SDKVM_HOME`
(default `~/.sdkvm`). Later upgrades run `sdkvm upgrade`.

Prerequisite: a [GitHub Release](https://github.com/QInJ1995/sdkvm/releases)
containing `sdkvm.tgz` and `SHA256SUMS` (uploaded by CI after a `v*` tag is pushed).

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.ps1 | iex
```

What the script does:

1. Downloads Node.js 22.20.0 into `$SDKVM_HOME/runtime` (CLI use only;
   `sdkvm node use` never touches it) and verifies it against the SHA-256 manifest.
2. Downloads `sdkvm.tgz` from the GitHub Release, verifies SHA-256, and
   extracts into `$SDKVM_HOME/cli` using a validate-then-atomic-replace flow
   that keeps the previous version on failure.
3. Writes the entrypoint `$SDKVM_HOME/bin/sdkvm` (`%SDKVM_HOME%\bin\sdkvm.cmd`
   on Windows) and adds that directory to the shell profile (zsh → `~/.zshrc`;
   bash → `~/.bash_profile` on macOS, `~/.bashrc` elsewhere) or the Windows
   user PATH, then broadcasts the environment change.

Open a new terminal afterwards (or `source` the rc file) and verify:

```console
$ sdkvm version
1.0.6
```

For a custom data root, **pass `SDKVM_HOME` on the install command itself**
(`curl | sh` does not read `~/.zshrc`):

```sh
SDKVM_HOME=/Volumes/Develop/sdkvm \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

Override download prefixes in restricted networks:

```sh
SDKVM_NODE_DIST=https://npmmirror.com/mirrors/node \
SDKVM_RELEASE_BASE=https://github.com/QInJ1995/sdkvm/releases \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

### npm / pnpm / yarn / bun (alternative)

Use this when Node.js >= 18.17 is already installed and you want the package
manager to own global tools. The CLI follows the `node` on `PATH`; a Node older
than 18.17 can stop the CLI from starting (`sdkvm node use 22` restores it).

```sh
npm install -g sdkvm
pnpm add -g sdkvm
yarn global add sdkvm
bun add -g sdkvm
```

## Upgrading the CLI

| Install method | Command | What changes |
| --- | --- | --- |
| Script (recommended) | `sdkvm upgrade` | Replaces `$SDKVM_HOME/cli` only; the runtime and installed SDKs stay |
| npm and friends | `npm update -g sdkvm` | CLI only; pnpm / yarn / bun use their own global update commands |

The data directory is independent of the CLI version. A script install can also
be refreshed by re-running the install script at any time.

## Quick start

Java accepts bare commands (`sdkvm install` equals `sdkvm java install`) or the
subcommand form; Go, Flutter, Node.js, Maven, Miniconda, and Python use the
`sdkvm <type>` subcommand groups.

```sh
# Optional: faster downloads (scoped per SDK type, independently)
sdkvm mirror use nju              # Java (Temurin)
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna   # only where sdkvm downloads Miniconda itself
sdkvm nrm use taobao              # only where npm install fetches packages
sdkvm mrm use aliyun              # only where mvn fetches dependencies (settings.xml)

# Java
sdkvm install lts
sdkvm use 25
java -version

# Go
sdkvm go install 1.24
sdkvm go use 1.24
go version

# Flutter (stable)
sdkvm flutter install 3.47
sdkvm flutter use 3.47
flutter --version

# Node.js (npm switches with this runtime)
sdkvm node install lts
sdkvm node use 24
node --version

# Maven (needs JAVA_HOME; run sdkvm java use first)
sdkvm maven install 3.9
sdkvm maven use 3.9
mvn -version

# Miniconda (installer is about 150 MB)
sdkvm miniconda install 26.7
sdkvm miniconda use 26.7
conda --version

# Python (prebuilt CPython; independent of Miniconda)
sdkvm python install 3.12
sdkvm python use 3.12
python --version

# Inspect and remove
sdkvm current
sdkvm java install 21 --vendor zulu
sdkvm java use zulu-21
sdkvm ls
sdkvm go ls
sdkvm uninstall zulu-21
```

After the first `use`, **open a new terminal**, or on macOS / Linux run
`source ~/.zshrc` (or the matching bash rc). Restart the IDE so it picks up the
new environment variables.

The daily workflow is three commands: `install` → `use` → `current` / `ls`.

## Command reference

### Command groups

| Group | Purpose |
| --- | --- |
| `sdkvm install / use / ls / current / uninstall / mirror` | Bare-command form for Java, fully equivalent to `sdkvm java …` |
| `sdkvm java …` | Java subcommand group (equivalent to the bare commands) |
| `sdkvm go / flutter / node / maven / miniconda / python …` | The same subcommand group for each SDK |
| `sdkvm nrm …` | npm registry manager |
| `sdkvm mrm …` | Maven dependency-mirror manager |
| `sdkvm version` / `sdkvm upgrade` | CLI metadata and self-upgrade |

Every SDK group exposes the same six subcommands — `install`, `use`, `ls`
(alias `list`), `current`, `uninstall`, and `mirror` — with the arguments
documented below.

### `sdkvm install <version>`

Resolves the version spec, downloads the archive (SHA-256 is computed while
bytes arrive), verifies it, extracts into a temp directory, validates the
layout, and moves it atomically into place.

```console
$ sdkvm install 21
sdkvm resolving Adoptium Temurin 21 for mac/aarch64 ...
sdkvm downloading https://github.com/adoptium/temurin21-binaries/releases/...
↓ Temurin 21.0.12.1  160.2MB / 200.4MB
sdkvm installed Temurin 21.0.12.1 → ~/.sdkvm/jdks/temurin-21.0.12.1
sdkvm switch to it: sdkvm use 21
```

| Option | Meaning |
| --- | --- |
| `--vendor <id>` | Pin the distribution. Java: `temurin` (default) / `zulu` / `corretto`; Go is `golang`, Flutter is `flutter`, Node.js is `nodejs`, Maven is `maven`, Miniconda is `miniconda`, Python is `cpython` |
| `--force` | Delete and reinstall when already present; the default is to skip |

Behavior notes:

- The switch hint printed after a successful install is the shortest spec that
  selects that exact install; when a newer version of the same major is already
  installed, the hint is automatically vendor-qualified (for example
  `sdkvm use zulu-21.0.5+11`) so a bare `use 21` cannot be captured by another
  vendor's newer build.
- A failed checksum or a malformed extract removes the partial directory and
  the cache entry.
- The download timeout is 60 seconds without data (idle timeout), not a cap on
  total time.
- Archives containing escaping paths (zip-slip) or outward-pointing symlinks
  are rejected.

### `sdkvm use <version>`

Matches an **installed** version, retargets the `current-*` link, and keeps the
environment variables (`JAVA_HOME` / `GO_HOME` / `FLUTTER_HOME` / `NODE_HOME` /
`MAVEN_HOME` / `MINICONDA_HOME` / `PYTHON_HOME`) and `PATH` in effect.

```sh
sdkvm use 21
sdkvm use temurin-21.0.5+11
sdkvm go use 1.24.5
sdkvm flutter use 3.47.5
sdkvm node use 22.20.0
sdkvm maven use 3.9
sdkvm miniconda use 26.7
sdkvm python use 3.12
```

| Option | Meaning |
| --- | --- |
| `--vendor <id>` | Restrict matching to one distribution |

Matching rules:

- A bare `use <major>` (for example `use 21`) selects the newest installed
  version of that major **across all vendors**; use a `vendor-` prefix or
  `--vendor` to pin a distribution.
- Java exact versions match by prefix: `21.0.5` matches `21.0.5+11`, and the
  reverse also holds (`use zulu-21.0.5+11` matches a `zulu-21.0.5` directory
  whose name omits the build number).

On macOS / Linux the first `use` appends a marked init block to the shell rc
(see [Switching](#switching)); open a new terminal or `source` it. Later
switches only retarget the link. IDEs need a restart. Maven requires a JDK: if
`JAVA_HOME` is unset, `use` points you at `sdkvm java use`.

### `sdkvm ls`

Lists installed versions; `→` marks the current one. Alias `list`.

```console
$ sdkvm go ls
→ golang-1.24.5
  golang-1.23.9
```

| Option | Meaning |
| --- | --- |
| `-r, --remote` | Fetch installable version lines from every vendor of the type in parallel; the latest 12 lines are shown, older versions install by exact name |
| `--vendor <id>` | Limit `--remote` output to one vendor |

```console
$ sdkvm flutter ls -r

# Flutter (official)
  flutter-3.47  latest: flutter-3.47.5
  flutter-3.44  latest: flutter-3.44.9

# install with: sdkvm flutter install <name>
```

In `-r` mode an individual vendor failure prints a warning and the rest
continue; if every vendor fails, the command exits 1.

### `sdkvm current`

Shows the current version and target of every enabled SDK. Types with nothing
installed are omitted. The bare command shows Java; `sdkvm <type> current`
shows that type.

```console
$ sdkvm current
java: temurin-21.0.12.1
  JAVA_HOME → ~/.sdkvm/jdks/temurin-21.0.12.1
go: golang-1.24.5
  GO_HOME → ~/.sdkvm/gos/golang-1.24.5
node: nodejs-22.20.0
  NODE_HOME → ~/.sdkvm/nodes/nodejs-22.20.0
maven: maven-3.9.9
  MAVEN_HOME → ~/.sdkvm/mavens/maven-3.9.9
miniconda: miniconda-py313_26.7.1-1
  MINICONDA_HOME → ~/.sdkvm/minicondas/miniconda-py313_26.7.1-1
python: cpython-3.12.7
  PYTHON_HOME → ~/.sdkvm/pythons/cpython-3.12.7
```

### `sdkvm uninstall <version>`

Removes an installed version. Same syntax as `use`.

| Option | Meaning |
| --- | --- |
| `--vendor <id>` | Restrict matching to one distribution |

- Removing a **non-current** version deletes only that directory; other
  versions and the current link are untouched.
- Removing the **current** version deletes the directory, then clears that
  `current-*` link — on macOS / Linux the SDK's sdkvm block is removed from the
  rc file, on Windows the matching environment variables and user PATH entries
  are removed — and prompts you to pick another version.
- An unknown version prints the installed versions and exits 1.

### `sdkvm mirror [action] [nameOrVendor] [url]`

Manages the **download mirror for SDK install archives** — not the npm package
registry and not conda channels. Java uses the bare `sdkvm mirror`; other types
use `sdkvm go|flutter|node|maven|miniconda|python mirror`. Scopes are independent.

```sh
sdkvm mirror ls
sdkvm mirror use nju
sdkvm go mirror use aliyun
sdkvm node mirror use official   # restore the official source for this type
```

| Action | Meaning |
| --- | --- |
| `ls` | List available sites and the current selection for this type |
| `current` / `show` | Print the effective mirror configuration |
| `use <site>` | Switch to a built-in site (`nju` / `tuna` / `aliyun` / `huawei` / `ustc` / `official`; aliases `tsinghua`→`tuna`, `ali`→`aliyun`); writes only the vendors of the current type |
| `set [vendor] <url>` | Set a raw mirror root URL |
| `unset` | Clear the manual configuration for this type |

See [Mirrors and registries](#mirrors-and-registries) for the coverage matrix
and raw-URL examples.

### `sdkvm nrm <command>`

Manages the user-level **npm registry** (where `npm install` fetches packages).
The UX follows [nrm](https://github.com/Pana/nrm). Fully independent of
`mirror`. Requires `npm` on `PATH` (on Windows it invokes npm's own
`npm-cli.js` without a shell).

| Subcommand | Meaning |
| --- | --- |
| `ls` / `list` | List registries; `*` marks the current one |
| `current` | Print the current registry |
| `use <name>` | Switch the user-level registry |
| `add <name> <url>` | Add a custom registry |
| `del <name>` (alias `delete`) | Delete a custom registry |
| `test [name]` | Ping registries and print latency |

```sh
sdkvm nrm ls
sdkvm nrm use taobao
sdkvm nrm use npm
sdkvm nrm add myprivate http://xxx/registry
sdkvm nrm del myprivate
sdkvm nrm test
```

Built-in names: `npm`, `yarn`, `taobao` (alias `npmmirror`), `tencent`, `cnpm`,
`huawei`, `npmMirror`. `custom` is a reserved name rejected by `add`; `test`
probes all registries concurrently and exits non-zero only when every probe
fails (a single failure just marks that row). When `del` removes the registry
currently in use, the npm config is reverted to the official npm registry so
`.npmrc` never points at a deleted address.

### `sdkvm mrm <command>`

Manages mirrors for Maven **dependencies and plugins** by writing a marked
`<mirror>` block into `settings.xml`. The UX follows `sdkvm nrm`. It never
invokes `mvn`, stores no credentials, and does not touch `MAVEN_HOME`.
Independent of `sdkvm maven mirror`, which only changes the Maven **install
archive** URL.

| Subcommand | Meaning |
| --- | --- |
| `ls` / `list` | List repository mirrors; `*` marks the current one |
| `current` | Print the current mirror and the settings path |
| `use <name>` | Switch the mirror (writes the marker block) |
| `add <name> <url>` | Add a custom repository mirror |
| `del <name>` (alias `delete`) | Delete a custom repository mirror |
| `test [name]` | GET a known POM from each repository and print latency |
| `settings [path\|unset]` | Show, set, or clear the settings.xml path |

```sh
sdkvm mrm ls
sdkvm mrm use aliyun
sdkvm mrm use official
sdkvm mrm add myrepo https://example.com/maven
sdkvm mrm del myrepo
sdkvm mrm test
sdkvm mrm settings
sdkvm mrm settings ~/.m2/settings.xml
sdkvm mrm settings unset
sdkvm mrm --settings /tmp/settings.xml use aliyun
```

Built-in names: `official` (removes the sdkvm marker block and keeps your other
mirrors), `aliyun` (alias `ali`, the aggregate repo `repository/public`),
`huawei`, `tencent`.

Behavior notes:

- Only the region between `<!-- >>> sdkvm mrm >>> -->` and
  `<!-- <<< sdkvm mrm <<< -->` is edited (`id=sdkvm`, `mirrorOf=*`); other
  mirrors, servers, and profiles stay untouched, and `use official` deletes
  only that block.
- settings.xml path precedence: the `--settings` flag > the `SDKVM_M2_SETTINGS`
  environment variable > `config.mavenSettings` > `~/.m2/settings.xml`. The
  first two are not saved.
- When the path is not Maven's default, `use` prints the required `mvn -s <path>`.
- Writes go through a temp file with atomic rename and share sdkvm's file lock.
- `custom` is a reserved name rejected by `add`; `test` exits non-zero only
  when every repository fails.
- Unpaired marker comments (manual-edit leftovers) abort the command with a
  repair hint. Markers are recognized only as **standalone lines**; the same
  text appearing mid-line is user content and never treated as a block boundary.
- When `del` removes the mirror currently in effect, the sdkvm block is removed
  automatically (back to the official repository).
- A settings.xml that is not valid UTF-8 (GBK comments, for example) is backed
  up to `settings.xml.sdkvm-bak` before any write; no irreversible re-encoding
  is performed.

### `sdkvm version` and `sdkvm upgrade`

```console
$ sdkvm version
1.0.6
```

`sdkvm upgrade` (no arguments): for a script install it downloads the new
release and atomically replaces `$SDKVM_HOME/cli`; for an npm-family install it
prints the matching package-manager update command. Installed SDKs and
configuration are untouched. The upgrade holds the file lock.

## Version specification

`install`, `use`, and `uninstall` share one version-spec grammar. Forms that
are not listed are rejected with a rewrite suggestion.

### Master table

| Form | Java | Go | Flutter | Node.js | Maven | Miniconda | Python | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<major>` | Latest patch of that major | — | — | Latest of that major | Latest stable of that major | Newest of that major | Newest stable of that major | `21`, `22`, `3`, `26` |
| `<major.minor>` | — | Latest patch of that minor line | Latest stable patch of that minor line | — | Latest stable of that minor | Newest of that minor line | Newest stable of that minor line | `1.24`, `3.47`, `3.9`, `3.12`, `26.7` |
| `lts` | Latest LTS major | — | — | Latest LTS line (currently 24 Krypton) | — | — | — | `lts` |
| `latest` | — | Newest stable | Newest stable, not beta | Newest Current | Newest stable, not prerelease | Newest installer for this OS | Newest stable, not prerelease | `latest` |
| `<full-version>` | Exact or prefix | Exact | Exact, including a prerelease | Exact | Exact, including a prerelease | Build or Python tag | Exact, including a prerelease | `21.0.5+11`, `1.24.5`, `22.20.0`, `3.12.7`, `py313_26.7.1-1` |
| `<vendor>-…` | Pin a distribution | Same | Same | Same | Same | Same | Same | `zulu-21`, `maven-3.9.9`, `cpython-3.12.7` |

### Per-SDK rules

Every SDK tolerates a `v` prefix in version input, and Go additionally tolerates
`go` (`go1.24.3` equals `1.24.3`). JDK 8 cross-vendor ordering compares the
unified update number (Corretto `8.504.01.1` and Temurin `8.0.504+1` count as
the same update).

- **Java**: `lts` follows the Adoptium list, currently 8 / 11 / 17 / 21 / 25.
  `21.0.5` is a prefix and matches `21.0.5+11`. The legacy major form `1.8`
  equals `8`; update-style input such as `1.8.0_392` is not supported — use `8`
  (latest) or `8.0.392+b06` (an exact build). An exact Temurin JDK 8 version
  must carry a build number (for example `8.0.504+6`); otherwise sdkvm suggests
  `install 8` or `ls -r`. Zulu keeps the build number in its version metadata
  rather than the directory name; exact matching bridges that difference.
- **Go**: `latest` resolves to the newest stable release; exact versions match
  the full string.
- **Flutter**: `latest` and `<major.minor>` resolve on the stable channel only;
  a beta needs the full prerelease, for example `3.49.0-0.1.pre`.
- **Node.js**: a two-part version such as `22.20` is rejected — use `22` or
  `22.20.0`. `lts` is the newest `index.json` entry carrying an LTS codename.
- **Maven**: only stable `x.y.z` releases from 3.0 upward are listed; `latest`,
  `3`, and `3.9` skip prereleases — install `4.0.0-rc-4` with the full string.
  There is no `lts` alias.
- **Miniconda**: versions look like `py313_26.7.1-1`. `26` is the newest of
  that major, `26.7` the newest of that minor line, `26.7.1-1` the highest
  Python for that build, `py313` the newest installer for that Python, and
  `py313_26.7.1-1` pins both. No `lts` alias; the `latest` filename alias is
  ignored.
- **Python**: versions look like `3.12.7`. `3`, `3.12`, and `latest` stay on
  stable releases; a prerelease such as `3.14.0rc2` must be written in full.
  No `lts` alias. The build date `+20260924` is not part of the directory name.
  This is the CPython distribution and does not change conda channels. When
  both Python and Miniconda are in use, the rc block written later comes first
  on `PATH`.

### Vendor prefix

Omitting the vendor prefix uses the default distribution. Only Java's default
is configurable (`config.defaultVendor`, default `temurin`). See
[Config file](#config-file).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (warnings that do not affect the result are permitted) |
| `1` | Operational error: unresolvable version, checksum failure, network unreachable, lock conflict, corrupt configuration, and so on; the message carries a next-step hint. `ls -r` also exits `1` when every vendor fetch fails |

## How it works

### Directory layout

The data root defaults to `~/.sdkvm` (`%USERPROFILE%\.sdkvm` on Windows);
`SDKVM_HOME` overrides it. Installs, links, configuration, and caches all live
inside it.

```
~/.sdkvm/
├── jdks/             # Java: temurin-21.0.12.1
├── gos/              # Go: golang-1.24.5
├── flutters/         # Flutter: flutter-3.47.5
├── nodes/            # Node.js: nodejs-22.20.0
├── mavens/           # Maven: maven-3.9.9
├── minicondas/       # Miniconda: miniconda-py313_26.7.1-1
├── pythons/          # Python: cpython-3.12.7
├── current-java      # JAVA_HOME target (junction on Windows)
├── current-go
├── current-flutter
├── current-node
├── current-maven
├── current-miniconda
├── current-python
├── runtime/          # script-install runtime, isolated from current-node
├── cli/              # script-install CLI package
├── bin/              # script-install entrypoint (must be on PATH)
├── config.json       # user configuration
├── .lock             # exclusive file lock
├── cache/            # download staging, cleared after installs
└── tmp/              # extract staging, also cleared
```

Unpacked sizes, roughly: Java 300 MB, Go 250 MB, Node.js 100 MB (bundled npm
included), Maven about 10 MB, Python archives about 20–40 MB, Miniconda
installers about 150 MB, Flutter several GB (the archive is about 1–2.2 GB).

### Switching

**macOS / Linux**: each `current-*` entry is a symlink to the selected
version. The first `use` appends a marked init block to the shell rc: zsh
writes `~/.zshrc`; bash writes `~/.bash_profile` (macOS) or `~/.bashrc`
(elsewhere). Each of the seven SDKs has its own block; the existing file
encoding is checked before writing, and non-standard UTF-8 content is backed
up first. Markers are recognized only as **standalone lines** — the same text
mid-line is user content. The Miniconda block also sources `conda.sh` so
`conda activate` works (under fish it exports `CONDA_EXE` and friends and
suggests `conda init fish`). After both Python and Miniconda are switched, the
block written later comes first on `PATH`.

```sh
# >>> sdkvm java init >>>
export JAVA_HOME="$HOME/.sdkvm/current-java"
case ":$PATH:" in *":$JAVA_HOME/bin:"*) ;; *) export PATH="$JAVA_HOME/bin:$PATH";; esac
# <<< sdkvm java init <<<

# >>> sdkvm go init >>>
export GO_HOME="$HOME/.sdkvm/current-go"
case ":$PATH:" in *":$GO_HOME/bin:"*) ;; *) export PATH="$GO_HOME/bin:$PATH";; esac
# <<< sdkvm go init <<<

# >>> sdkvm flutter init >>>
export FLUTTER_HOME="$HOME/.sdkvm/current-flutter"
case ":$PATH:" in *":$FLUTTER_HOME/bin:"*) ;; *) export PATH="$FLUTTER_HOME/bin:$PATH";; esac
# <<< sdkvm flutter init <<<

# >>> sdkvm node init >>>
export NODE_HOME="$HOME/.sdkvm/current-node"
case ":$PATH:" in *":$NODE_HOME/bin:"*) ;; *) export PATH="$NODE_HOME/bin:$PATH";; esac
# <<< sdkvm node init <<<

# >>> sdkvm maven init >>>
export MAVEN_HOME="$HOME/.sdkvm/current-maven"
case ":$PATH:" in *":$MAVEN_HOME/bin:"*) ;; *) export PATH="$MAVEN_HOME/bin:$PATH";; esac
# <<< sdkvm maven init <<<

# >>> sdkvm miniconda init >>>
export MINICONDA_HOME="$HOME/.sdkvm/current-miniconda"
case ":$PATH:" in *":$MINICONDA_HOME/bin:"*) ;; *) export PATH="$MINICONDA_HOME/bin:$PATH";; esac
export CONDA_EXE="$MINICONDA_HOME/bin/conda"
export CONDA_PYTHON_EXE="$MINICONDA_HOME/bin/python"
[ -f "$MINICONDA_HOME/etc/profile.d/conda.sh" ] && . "$MINICONDA_HOME/etc/profile.d/conda.sh"
# <<< sdkvm miniconda init <<<

# >>> sdkvm python init >>>
export PYTHON_HOME="$HOME/.sdkvm/current-python"
case ":$PATH:" in *":$PYTHON_HOME/bin:"*) ;; *) export PATH="$PYTHON_HOME/bin:$PATH";; esac
# <<< sdkvm python init <<<
```

The variables point at the link rather than a concrete directory, so later
`use` calls only retarget it and new terminals read the new value without any
further rc edits.

**Windows**: the seven `current-*` entries are junctions. `use` writes user
environment variables as `REG_EXPAND_SZ`, keeping `%VAR%` references and
avoiding the 1024-character `setx` truncation. PATH gains `%JAVA_HOME%\bin`,
`%GO_HOME%\bin`, `%FLUTTER_HOME%\bin`, and `%MAVEN_HOME%\bin`; the Windows
Node.js archive has no `bin/`, so its PATH entry is `%NODE_HOME%` itself;
Miniconda adds `%MINICONDA_HOME%`, `%MINICONDA_HOME%\Scripts`, and
`%MINICONDA_HOME%\Library\bin`; Python adds `%PYTHON_HOME%` (`python.exe`) and
`%PYTHON_HOME%\Scripts` (`pip.exe`). A `WM_SETTINGCHANGE` broadcast follows;
open terminals and IDEs still need a restart. `conda activate` inside
PowerShell is out of scope.

### Concurrency and the file lock

Installs, switches, removals, `upgrade`, and `mrm use` hold the exclusive
`~/.sdkvm/.lock`:

- The lock covers only the **mutation phase**: an install's download,
  verification, and extraction run outside it (they write only private
  temporaries under `cache/` and `tmp/`); mutual exclusion covers the
  install-directory swap and installer execution. While a multi-hundred-MB
  archive downloads, `use` / `uninstall` / `ls` keep working.
- While an operation holds the lock, a new one fails immediately with a hint
  (`Another sdkvm operation is in progress`) that includes how to clear the
  lock manually.
- The lock file records the holder PID and a heartbeat timestamp refreshed
  while the lock is held. A dead holder, or a heartbeat more than 5 minutes
  stale, lets the next waiter take over safely.
- On a false positive (no other sdkvm process running), delete
  `~/.sdkvm/.lock` as the error message suggests.

### Downloads and integrity

- Download URLs are resolved from official APIs or official directory listings
  (Adoptium, Azul Metadata, Corretto, go.dev/dl, Flutter releases,
  nodejs.org/dist `index.json`, Maven Central `maven-metadata.xml`). Search
  pages are never scraped.
- SHA-256 is computed while the archive streams in and compared against the
  checksum source: Go, Flutter, Node.js (official `SHASUMS256.txt`), Miniconda,
  and Python abort on mismatch; Maven checks the official `.sha512` (falling
  back to the published `.sha1` for 3.8 and older); Java vendors verify
  whenever a checksum is available — Temurin and Zulu hashes are prefetched
  from the official APIs, Corretto `21` / `lts` uses the official
  `latest_sha256`; an exact Corretto version uses the sha256 printed next to
  that filename in the official GitHub release notes (the `.sha256` file beside
  the archive returns 403). If that release has no hash, install warns and skips
  verification.
- **Strict verification** applies to mirrored downloads and to installers that
  will be **executed** (Miniconda): if no verifiable hash can be obtained, the
  install fails rather than proceeding.
- When a checksum source is unreachable, the fallback order is the official
  sidecar (for example Temurin `.json`, Maven `.sha512`) and then the same file
  on the mirror; the install fails if both are unreachable or the hash differs.
- The download idles out after 60 seconds without data (no total-time cap);
  checksum requests retry automatically.
- After extraction the tree must have a single root and the expected
  executable; extraction always targets a fresh empty directory, and archive
  entries (symlinks included) may not escape it. Any failure path clears the
  partial files in `cache/` and `tmp/`.

## Configuration

### Config file

Path: `~/.sdkvm/config.json`. A corrupt file is backed up as `config.json.bak`
and replaced with defaults. All writes use a temp file plus atomic rename.

```json
{
  "version": 1,
  "defaultVendor": "temurin",
  "mirror": {
    "temurin": "https://mirrors.nju.edu.cn/adoptium",
    "golang": "https://golang.google.cn/dl",
    "flutter": "https://mirror.nju.edu.cn/flutter/flutter_infra_release",
    "nodejs": "https://mirror.nju.edu.cn/nodejs-release",
    "maven": "https://maven.aliyun.com/repository/central"
  },
  "npmRegistries": {
    "myprivate": "http://xxx/registry/"
  },
  "mavenRegistries": {
    "myrepo": "https://example.com/maven/"
  },
  "mavenSettings": ""
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `version` | Config schema version | `1` |
| `defaultVendor` | Java distribution used when the vendor prefix is omitted | `"temurin"` |
| `mirror` | Vendor id to mirror root URL; vendor ids are unique across SDKs | `{}` |
| `npmRegistries` | Custom npm registries from `sdkvm nrm add` | `{}` |
| `mavenRegistries` | Custom Maven repositories from `sdkvm mrm add` | `{}` |
| `mavenSettings` | Absolute `settings.xml` path; empty uses the default location | `""` |

### Environment variables

| Variable | Meaning |
| --- | --- |
| `SDKVM_HOME` | Data root; default `~/.sdkvm` |
| `SDKVM_MIRROR` | One-shot mirror; wins over the config file and is not saved |
| `SDKVM_M2_SETTINGS` | `settings.xml` for this `sdkvm mrm` run; not saved |
| `SDKVM_QUIET` | When non-empty, suppresses info and warn logs |
| `SDKVM_NODE_DIST` | Node distribution root used by the install script |
| `SDKVM_RELEASE_BASE` | GitHub Release root used by the install script and `sdkvm upgrade` |
| `SDKVM_RUNTIME_NODE` | Node version bundled by the install script; default `22.20.0` |

Mirror precedence: `SDKVM_MIRROR` > `config.mirror[<vendor>]` > official source.

## Mirrors and registries

Three independent features with different targets — do not conflate them:

| | `sdkvm mirror` | `sdkvm nrm` | `sdkvm mrm` |
| --- | --- | --- | --- |
| Changes | Where sdkvm downloads JDK / Go / Flutter / Node / Maven / Miniconda / Python archives | The **npm package** registry | Maven **dependency / plugin** repositories (`settings.xml`) |
| Affects | `sdkvm … install` | `npm install` | `mvn` dependency resolution |
| Scope | Per SDK type | User-level global | One `settings.xml` |

### SDK install mirrors

Prefer a built-in site per type (`use` writes only the vendors of the current
type):

```sh
sdkvm mirror use nju
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna
```

Coverage matrix (`✓` means the site mirrors that SDK):

| Site | Java (temurin) | Go | Flutter | Node.js | Maven | Miniconda | Python |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nju` | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| `tuna` | ✓ | — | — (directory offline; not listed) | — (incomplete archives; not listed) | — | ✓ | — |
| `aliyun` | — | ✓ | — | ✓ | ✓ | — | — |
| `huawei` | — | — | — | ✓ | ✓ | — | — |
| `ustc` | — | — | — | — | — | ✓ | — |
| `official` | Clear this type | Clear this type | Clear this type | Clear this type | Clear this type | Clear this type | Clear this type |

Rewrite strategy and verified sites per vendor:

| Vendor | Notes |
| --- | --- |
| Temurin | Adoptium directory layout; verified against [NJU](https://mirrors.nju.edu.cn/adoptium) and [TUNA](https://mirrors.tuna.tsinghua.edu.cn/Adoptium) |
| Go | File name appended to the root; e.g. `nju` / `aliyun` |
| Flutter | Bucket-prefix replacement; verified against [NJU](https://mirror.nju.edu.cn/flutter/flutter_infra_release). Do not use `storage.flutter-io.cn` (no release manifest) or TUNA flutter (directory offline, 404) |
| Node.js | Prefix replacement; verified against [NJU](https://mirror.nju.edu.cn/nodejs-release). Do not use TUNA nodejs-release (missing archives) |
| Maven | Central path-prefix replacement; verified against [Aliyun central](https://maven.aliyun.com/repository/central) and [Huawei maven](https://repo.huaweicloud.com/repository/maven) |
| Miniconda | Installer-directory prefix replacement; verified against NJU / TUNA / USTC. Aliyun does not host that directory |
| Python | GitHub `releases/download` prefix replacement keeping `/{tag}/{filename}`; the manifest and checksums stay official. No verified preset site yet — use `mirror set` |
| Zulu, Corretto | Official CDN only; no mirror support yet |

Raw URL or one-shot override:

```sh
sdkvm go mirror set golang https://golang.google.cn/dl
sdkvm python mirror set cpython https://mirror.example/python-build-standalone
SDKVM_MIRROR=https://golang.google.cn/dl sdkvm go install 1.24
```

A mirror replaces the archive URL only; version metadata and checksums prefer
the official API, with the fallback order described in
[Downloads and integrity](#downloads-and-integrity).

### npm registry

```sh
sdkvm nrm use taobao   # common in China
sdkvm nrm use npm      # official
sdkvm nrm test         # latency
```

### Maven dependency mirrors

`sdkvm mrm` writes or removes a marker block in `settings.xml` (`mirrorOf=*`,
`id=sdkvm`). `use official` deletes only that block; other mirrors, servers,
and profiles stay. Aliyun here is the aggregate repo `repository/public`, not
the install-archive repo `repository/central`.

```sh
sdkvm mrm use aliyun    # dependencies via Aliyun public
sdkvm mrm use official  # remove the sdkvm mirror block
sdkvm mrm settings ~/work/settings.xml
mvn -s ~/work/settings.xml compile   # pass -s yourself for non-default paths
```

## Security model

- **Trusted origins.** Download URLs come from official APIs, never scraped
  search pages, and no script returned by a mirror is ever executed; https
  redirects may not downgrade to http.
- **Transport integrity.** SHA-256 is streamed during download and compared
  against official manifests before anything lands; mirrors and installers are
  strictly verified — no hash, no install.
- **Contained extraction.** Archives unpack only into a fresh empty directory,
  must have a single root and the expected executable, and no entry (symlink
  targets included) may escape it (zip-slip protection).
- **Minimal writes.** Host changes are limited to marked rc blocks or
  user-level environment variables; config and settings.xml are replaced
  atomically; no credentials are stored (mrm repository URLs may not carry
  usernames or passwords; nrm writes no tokens).
- **Process mutual exclusion.** Write operations hold an exclusive file lock
  so concurrent runs cannot overwrite each other.
- **Execution boundary.** The Miniconda installer runs silently only after its
  hash verifies; Windows registry and script operations go through controlled
  argument construction, never concatenated shell strings.

## Troubleshooting

### The command is still the old version after `use`

The rc block applies in a new terminal or after `source ~/.zshrc`; restart the
IDE. Check `sdkvm current` to see whether the link already moved. On Windows
the registry is updated, but an open terminal keeps the old values.

### `Another sdkvm operation is in progress`

After confirming no other sdkvm process is running (including an interrupted
download), remove `~/.sdkvm/.lock` as the message suggests. When the holder
exits normally or its heartbeat goes more than 5 minutes stale, the lock is
taken over automatically, so manual cleanup is rarely needed.

### `GOROOT` / `FLUTTER_ROOT` were renamed

They are now `GO_HOME` and `FLUTTER_HOME` (aligned with `JAVA_HOME` /
`NODE_HOME`). After upgrading the CLI, run `use` again for each enabled SDK and
remove leftover old variable names from the user environment (Windows registry
/ hand-edited rc lines).

### fish or nushell

When `$SHELL` ends in `fish`, `use` writes `~/.config/fish/config.fish`.
nushell is not written automatically; `use` prints a paste-ready block instead.
To translate the blocks in [Switching](#switching) yourself, use this fish example:

```fish
set -gx JAVA_HOME $HOME/.sdkvm/current-java
set -gx GO_HOME $HOME/.sdkvm/current-go
set -gx FLUTTER_HOME $HOME/.sdkvm/current-flutter
set -gx NODE_HOME $HOME/.sdkvm/current-node
set -gx MAVEN_HOME $HOME/.sdkvm/current-maven
fish_add_path $JAVA_HOME/bin $GO_HOME/bin $FLUTTER_HOME/bin $NODE_HOME/bin $MAVEN_HOME/bin
```

### Flutter downloads are slow or stop

Run `sdkvm flutter mirror use nju` first (TUNA's flutter directory is offline
and unusable). The timeout is 60 seconds without data, so a steady slow
transfer continues. Re-run `install` after a real interruption; nothing
partial is left behind.

### Install a Flutter beta

Pass the full prerelease, for example `sdkvm flutter install 3.49.0-0.1.pre`.
`latest` and `3.47` resolve on stable only.

### Does a managed Node break sdkvm itself?

A script install launches the CLI with `~/.sdkvm/runtime`, so `sdkvm node use`
does not affect it. An npm global install follows the `node` on `PATH`; a Node
older than 18.17 can stop the CLI — `sdkvm node use 22` brings it back.

### Difference between `mirror`, `nrm`, and `mrm`

See [Mirrors and registries](#mirrors-and-registries): `mirror` is for SDK
install archives, `nrm` for npm packages, and `mrm` for Maven dependency
repositories (`settings.xml`).

### Proxies

CLI downloads (SDK archives, version manifests) honor the standard proxy
variables: `HTTPS_PROXY` / `HTTP_PROXY` (either case), `ALL_PROXY`, and
`NO_PROXY`. Note that `sdkvm node` / `nrm` switch the **npm** registry;
npm's own proxy is still managed by npm config.

### Isolating data for CI or multiple users

Set `SDKVM_HOME=/path/to/dir`. Installs, links, and configuration all follow
that directory, giving per-project or per-user isolation for free.

## Uninstall

**npm install**:

```sh
npm uninstall -g sdkvm
```

pnpm, yarn, and bun use their own global uninstall commands.

**Script install**: remove the entrypoint and CLI first (installed SDKs are
unaffected):

```sh
rm -rf ~/.sdkvm/bin ~/.sdkvm/cli ~/.sdkvm/runtime
```

On Windows, delete `%USERPROFILE%\.sdkvm\bin\sdkvm.cmd`, `%USERPROFILE%\.sdkvm\cli`,
and `%USERPROFILE%\.sdkvm\runtime`, and remove `%USERPROFILE%\.sdkvm\bin` from
the user PATH.

Once the installed SDKs are no longer needed, remove the data directory:

```sh
rm -rf ~/.sdkvm
```

Also clean the sdkvm blocks from the shell configuration:

- `# >>> sdkvm path >>>` … `# <<< sdkvm path <<<`
- each SDK's `# >>> sdkvm java|go|flutter|node|maven|miniconda|python init >>>` … `# <<< … <<<`

On Windows, additionally remove `JAVA_HOME`, `GO_HOME`, `FLUTTER_HOME`,
`NODE_HOME`, `MAVEN_HOME`, `MINICONDA_HOME`, and `PYTHON_HOME` from the user
environment, and remove `%JAVA_HOME%\bin`, `%GO_HOME%\bin`,
`%FLUTTER_HOME%\bin`, `%NODE_HOME%`, `%MAVEN_HOME%\bin`, `%MINICONDA_HOME%`,
`%MINICONDA_HOME%\Scripts`, `%MINICONDA_HOME%\Library\bin`, `%PYTHON_HOME%`,
and `%PYTHON_HOME%\Scripts` from the user PATH.

## Development

```sh
git clone https://github.com/QInJ1995/sdkvm.git && cd sdkvm
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` runs tsup and writes `dist/index.js`; try the CLI locally with
`node dist/index.js`. CI runs type checks, unit tests, build and pack, plus a
real install / switch / uninstall e2e flow on macOS, Ubuntu, and Windows, and a
script-install e2e (Ubuntu / Windows) that exercises `install.sh` /
`install.ps1` against a locally served release.

```
src/
├── cli/       # install / use / ls / uninstall / mirror / nrm / mrm / upgrade
├── core/      # version parsing, registry, config, file lock, platform detect
├── sdk/       # per-SDK directories, env vars, version syntax, binary paths
├── vendor/    # per-distribution listing and resolution, mirror rewrites
├── fs/        # extract, layout normalization, links
├── shell/     # rc writes, Windows registry
├── net/       # fetch, streaming download, checksums
└── ui/        # logs and progress
```

To add a language, implement `listMajors` and `resolve` under `src/vendor/`,
add a type descriptor under `src/sdk/` (install directory, current link,
environment variable, version syntax, binary path), and register it in
`sdk/index.ts` — install / use / ls / uninstall / mirror and the rc and
registry writes follow from that registration.

## License

[MIT](./LICENSE) © sdkvm contributors
