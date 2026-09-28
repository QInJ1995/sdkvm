<div align="center">

# sdkvm

**简单、跨平台的多语言 SDK 版本管理器**

[![npm version](https://img.shields.io/npm/v/sdkvm)](https://www.npmjs.com/package/sdkvm)
[![CI](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml/badge.svg)](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/sdkvm)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.15-green)](./package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#系统要求)

中文 | [English](./README.en.md)

管理 **Java JDK**、**Go 工具链**、**Flutter SDK**、**Node.js 运行时**、**Apache Maven**、**Miniconda** 与 **CPython**。

</div>

## 目录

- [简介](#简介)
- [系统要求](#系统要求)
- [安装](#安装)
- [升级](#升级)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [版本语法](#版本语法)
- [工作原理](#工作原理)
- [配置](#配置)
- [镜像与 npm 源](#镜像与-npm-源)
- [安全性](#安全性)
- [常见问题](#常见问题)
- [卸载](#卸载)
- [开发](#开发)
- [许可证](#许可证)

## 简介

`sdkvm` 用 Node.js 编写，负责多种语言 SDK 的安装、切换和卸载。

| SDK     | 来源                                                                                                                    | 说明                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Java    | [Temurin](https://adoptium.net/)、[Zulu](https://www.azul.com/downloads/)、[Corretto](https://aws.amazon.com/corretto/) | `lts` 当前为 8 / 11 / 17 / 21 / 25                               |
| Go      | [go.dev](https://go.dev/dl/)                                                                                            | 全历史稳定版                                                     |
| Flutter | 官方发布清单                                                                                                            | stable / beta；macOS 双架构，Linux / Windows 仅 x64              |
| Node.js | [nodejs.org/dist](https://nodejs.org/dist)                                                                              | `lts`（当前 24 Krypton）/ `latest` / 按 major 线；npm 随版本切换 |
| Maven   | [Maven Central](https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/)                                    | `3` / `3.9` / `latest` 取稳定版；预发布只能精确安装             |
| Miniconda | [repo.anaconda.com/miniconda](https://repo.anaconda.com/miniconda/) | `26` / `26.7` / `py313` / `py313_26.7.1-1` / `latest`；安装器约 150 MB |
| Python | [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | `3` / `3.12` / `3.12.7` / `3.14.0rc2` / `latest`；预编译 CPython，归档约 20–40 MB |

行为约定：

- 各 SDK 目录隔离，`JAVA_HOME`、`GO_HOME`、`FLUTTER_HOME`、`NODE_HOME`、`MAVEN_HOME`、`MINICONDA_HOME`、`PYTHON_HOME` 互不覆盖。
- `use` 只改一个符号链接（Windows 为 junction），不搬移已安装的文件。
- 下载地址由官方 API 或官方目录页解析。Go、Flutter、Node.js、Miniconda、Python 强制校验 SHA-256；Maven 强制校验官方 SHA-512；Java 各源尽力校验。
- Temurin、Go、Flutter、Node.js、Maven、Miniconda、Python 可配置镜像。校验和仍取自官方清单。`sdkvm miniconda mirror` 只决定 sdkvm 从哪里下载 Miniconda 本身，不改 conda 拉包频道。`sdkvm python mirror` 只改 CPython 归档的下载地址，清单仍走官方。Python 暂无核对过的预设站，用 `mirror set` 手填。
- 新增语言只需实现一个厂商模块，见[开发](#开发)。

## 系统要求

| 依赖     | 版本     | 说明                                                                              |
| -------- | -------- | --------------------------------------------------------------------------------- |
| Node.js  | >= 18.15 | npm 安装需要本机 Node。脚本安装自带隔离运行时，不要求预先安装                     |
| 操作系统 | —        | macOS（Apple Silicon / Intel）、主流 Linux、Windows 10+                           |
| 解压工具 | 系统自带 | macOS / Linux 用 `tar`；Windows 用 bsdtar，缺失时回退 PowerShell `Expand-Archive` |

平台限制：

- Linux 解压 Flutter（`.tar.xz`）需要 `xz`（`xz-utils`）。主流发行版默认自带。
- Flutter 官方在 Linux / Windows 只发布 x64 归档。ARM Linux 与 ARM Windows 无法安装。macOS 两种架构都支持。
- `flutter` 首次运行会构建内部 cache，耗时较久属于正常现象。
- Miniconda 安装器约 150 MB，静默安装视为接受 [Miniconda 条款](https://www.anaconda.com/legal)。Windows 安装路径不能含空格（含空格时请把 `SDKVM_HOME` 指到无空格目录）。Windows 仅 x64；macOS 双架构，Linux x64 与 aarch64 都支持。较新的版本可能只发布其中一部分平台。安装器下载后必须带有可核对的 SHA-256 才会执行（无论是否走镜像）。
- Python 使用 python-build-standalone 的 `install_only_stripped` 归档（没有则退回 `install_only`）。macOS、Linux、Windows 的 x64 与 aarch64 都支持。不安装 free-threaded、musl，也不选 `x86_64_v2` / `v3` / `v4`。列表只看最新一次构建快照；精确版本在最新快照里找不到时，会自动回退查最近几个历史 release 标签。

## 安装

**推荐使用安装脚本**：无需本机预装 Node.js，CLI 自带隔离运行时，数据与入口都在 `SDKVM_HOME`（默认 `~/.sdkvm`）下，升级用 `sdkvm upgrade` 即可。

### 安装脚本（推荐）

需要仓库已有带 `sdkvm.tgz` 与 `SHA256SUMS` 的 [GitHub Release](https://github.com/QInJ1995/sdkvm/releases)（打 `v*` tag 后由 CI 上传）。

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.ps1 | iex
```

脚本会：

1. 下载 Node.js 22.20.0 到 `$SDKVM_HOME/runtime`（仅启动 CLI，`sdkvm node use` 不会改到它）。
2. 从 GitHub Release 下载 `sdkvm.tgz`，校验 SHA-256 后解压到 `$SDKVM_HOME/cli`。
3. 写入 `$SDKVM_HOME/bin/sdkvm`（Windows 为 `%SDKVM_HOME%\bin\sdkvm.cmd`），并把该目录写入 shell 配置 / 用户 PATH（zsh→`~/.zshrc`，bash→`~/.bash_profile` 或 `~/.bashrc`）。

装完后重开终端，或 `source` 对应 rc，再验证：

```console
$ sdkvm version
1.0.5
```

自定义数据根时，**必须在安装命令的环境里带上** `SDKVM_HOME`（`curl | sh` 不会读取 `~/.zshrc`）：

```sh
SDKVM_HOME=/Volumes/Develop/sdkvm \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

国内可换下载前缀：

```sh
SDKVM_NODE_DIST=https://npmmirror.com/mirrors/node \
SDKVM_RELEASE_BASE=https://github.com/QInJ1995/sdkvm/releases \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

### npm / pnpm / yarn / bun（备选）

适合本机已有 Node.js >= 18.15、且希望用包管理器统一管理全局工具的场景。CLI 依赖 `PATH` 上的 `node`；若之后切到 18.15 以前的 Node，CLI 可能无法启动。

```sh
npm install -g sdkvm
pnpm add -g sdkvm
yarn global add sdkvm
bun add -g sdkvm
```

## 升级

| 安装方式     | 命令                  | 影响范围                                                  |
| ------------ | --------------------- | --------------------------------------------------------- |
| 脚本（推荐） | `sdkvm upgrade`       | 只替换 `$SDKVM_HOME/cli`。runtime 与已安装的 SDK 保持不变 |
| npm 等       | `npm update -g sdkvm` | 只更新 CLI。pnpm / yarn / bun 用各自的全局更新命令        |

数据目录与 CLI 升级无关。脚本安装也可以重新执行安装脚本。

## 快速开始

Java 可用裸命令（与 `sdkvm java` 等价）；Go / Flutter / Node / Maven / Miniconda / Python 用子命令。

```sh
# 可选：国内加速（按 SDK 类型分别设置，互不影响）
sdkvm mirror use nju          # Java Temurin
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna   # 只改 sdkvm 下载 Miniconda 的地址
sdkvm nrm use taobao          # 仅影响 npm install，与上面的 mirror 无关
sdkvm mrm use aliyun          # 仅影响 mvn 拉依赖，写入 settings.xml

# Java
sdkvm install lts
sdkvm use 25
java -version

# Go
sdkvm go install 1.24
sdkvm go use 1.24
go version

# Flutter（stable）
sdkvm flutter install 3.47
sdkvm flutter use 3.47
flutter --version

# Node.js（npm 随该版本一起切换）
sdkvm node install lts
sdkvm node use 24
node --version

# Maven（需要已有 JAVA_HOME）
sdkvm maven install 3.9
sdkvm maven use 3.9
mvn -version

# Miniconda（安装器约 150 MB）
sdkvm miniconda install 26.7
sdkvm miniconda use 26.7
conda --version

# Python（预编译 CPython，与 Miniconda 互不影响）
sdkvm python install 3.12
sdkvm python use 3.12
python --version

# 查看与卸载
sdkvm current
sdkvm java install 21 --vendor zulu
sdkvm java use zulu-21
sdkvm ls
sdkvm go ls
sdkvm uninstall zulu-21
```

首次 `use` 后请**重开终端**，或在 macOS / Linux 上 `source ~/.zshrc`（bash 则 source 对应 rc）。IDE 需重启才会读到新的环境变量。

日常只记三条：`install` → `use` → `current` / `ls`。安装包镜像、npm 源和 Maven 依赖镜像见[镜像与 npm 源](#镜像与-npm-源)。

## 命令参考

Java 使用裸命令（`sdkvm install`）或 `sdkvm java`，两者等价。Go、Flutter、Node.js、Maven、Miniconda、Python 分别使用 `sdkvm go`、`sdkvm flutter`、`sdkvm node`、`sdkvm maven`、`sdkvm miniconda`、`sdkvm python`。

### 命令速查

| 命令                                              | 作用                                               |
| ------------------------------------------------- | -------------------------------------------------- |
| `sdkvm install <version>`                         | 安装 Java（等于 `sdkvm java install`）             |
| `sdkvm use <version>`                             | 切换当前 Java                                      |
| `sdkvm ls` / `sdkvm ls -r`                        | 列出已安装版本 / 可安装版本线                      |
| `sdkvm current`                                   | 显示全部 SDK 的当前版本                            |
| `sdkvm uninstall <version>`                       | 卸载一个版本                                       |
| `sdkvm mirror ls\|use\|current\|show\|set\|unset` | 管理 SDK 下载镜像站 / URL（安装包，不是 npm 包源） |
| `sdkvm nrm ls\|use\|current\|add\|del\|test`      | 管理用户级 npm registry（类似 nrm）                |
| `sdkvm mrm ls\|use\|current\|add\|del\|test\|settings` | 管理 Maven 依赖镜像（`settings.xml`，类似 nrm） |
| `sdkvm java\|go\|flutter\|node\|maven\|miniconda\|python …` | 各 SDK 的完整命令组                                |
| `sdkvm version`                                   | 打印 CLI 版本（同 `sdkvm --version`）              |
| `sdkvm upgrade`                                   | 升级 CLI。见[升级](#升级)                          |

版本写法：

```sh
sdkvm java    install lts | 21 | 21.0.5 | 21.0.5+11 | zulu-21
sdkvm go      install latest | 1.24 | 1.24.5 | golang-1.24
sdkvm flutter install latest | 3.47 | 3.47.5 | 3.49.0-0.1.pre | flutter-3.47
sdkvm node    install lts | latest | 22 | 22.20.0 | nodejs-22.20.0
sdkvm maven   install latest | 3 | 3.9 | 3.9.9 | 4.0.0-rc-4 | maven-3.9
sdkvm miniconda install latest | 26 | 26.7 | 26.7.1-1 | py313 | py313_26.7.1-1
sdkvm python install 3 | 3.12 | 3.12.7 | 3.14.0rc2 | latest
```

### `sdkvm install <version>`

流程：解析、下载（边下边计算 SHA-256）、校验、解压到临时目录、原子落位。

```console
$ sdkvm install 21
sdkvm resolving Adoptium Temurin 21 for mac/aarch64 ...
sdkvm downloading https://github.com/adoptium/temurin21-binaries/releases/...
↓ Temurin 21.0.12.1  160.2MB / 200.4MB
sdkvm installed Temurin 21.0.12.1 → ~/.sdkvm/jdks/temurin-21.0.12.1
sdkvm switch to it: sdkvm use 21
```

| 选项            | 说明                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `--vendor <id>` | Java：`temurin`（默认）/ `zulu` / `corretto`。Go 为 `golang`，Flutter 为 `flutter`，Node.js 为 `nodejs`，Maven 为 `maven`，Miniconda 为 `miniconda`，Python 为 `cpython` |
| `--force`       | 已安装时删除并重装。默认跳过已安装版本                                                                  |

校验失败或解压异常时，半成品目录和缓存会被清掉。下载超时是 60 秒无数据，不是总时长上限。

### `sdkvm use <version>`

在已安装版本中匹配，并更新对应的 `current-*` 链接与 `JAVA_HOME` / `GO_HOME` / `FLUTTER_HOME` / `NODE_HOME` / `MAVEN_HOME` / `MINICONDA_HOME` / `PYTHON_HOME` / `PATH`。

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

macOS / Linux 上，首次 `use` 会向 shell 配置追加初始化块，重开终端或 `source ~/.zshrc` 后生效。之后的切换只改链接。IDE 需要重启才会读到新的环境变量。Maven 需要 JDK：没有 `JAVA_HOME` 时会提示先 `sdkvm java use`。详见[切换机制](#切换机制)。

### `sdkvm ls`

列出已安装版本，`→` 表示当前版本。

```console
$ sdkvm go ls
→ golang-1.24.5
  golang-1.23.9
```

`sdkvm ls -r`（`--remote`）并行拉取该类型全部厂商的可安装版本线。行首名称可以直接交给 `install`。默认显示最近 12 条线，更老的版本按精确名称安装。

```console
$ sdkvm flutter ls -r

# Flutter (official)
  flutter-3.47  latest: flutter-3.47.5
  flutter-3.44  latest: flutter-3.44.9

# install with: sdkvm flutter install <name>
```

`--vendor <id>` 只列出一个厂商。

### `sdkvm current`

未安装的类型不显示。

```console
$ sdkvm current
java: temurin-21.0.12.1
  JAVA_HOME → ~/.sdkvm/jdks/temurin-21.0.12.1
go: golang-1.24.5
  GO_HOME → ~/.sdkvm/gos/golang-1.24.5
flutter: flutter-3.47.5
  FLUTTER_HOME → ~/.sdkvm/flutters/flutter-3.47.5
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

语法与 `use` 相同。卸载当前版本时会清掉对应的 `current-*` 链接：macOS/Linux 同时移除 rc 文件里的 sdkvm 标记块，Windows 同时清理对应环境变量与用户 PATH 条目；然后提示另选版本。其他已安装版本保留。

### `sdkvm mirror`

按 SDK 类型管理**下载该 SDK 的镜像**（不是 npm 包源，也不是 conda 频道）。Java：`sdkvm mirror`；其余：`sdkvm go|flutter|node|maven|miniconda|python mirror`。作用域互不影响。`sdkvm miniconda mirror` 只决定 sdkvm 从哪里下载 Miniconda 本身。`sdkvm python mirror` 只改 CPython 归档地址。

```sh
sdkvm mirror ls
sdkvm mirror use nju
sdkvm go mirror use aliyun
sdkvm node mirror use official   # 恢复该类型官方源
```

| 动作                           | 说明                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `ls` / `current` / `show`      | 查看本类型可用站与当前配置                                          |
| `use <site>`                   | 一键切换内置站（`nju` / `tuna` / `aliyun` / `huawei` / `official`） |
| `set [vendor] <url>` / `unset` | 手填或清除 URL                                                      |

站点覆盖与手填示例见[镜像与 npm 源](#镜像与-npm-源)。

### `sdkvm nrm`

管理用户级 **npm registry**（`npm install` 拉包地址），风格接近 [nrm](https://github.com/Pana/nrm)。与 `mirror` 无关。

```sh
sdkvm nrm ls
sdkvm nrm use taobao
sdkvm nrm use npm
sdkvm nrm add myprivate http://xxx/registry
sdkvm nrm del myprivate
sdkvm nrm test
```

内置名：`npm`、`yarn`、`taobao`（别名 `npmmirror`）、`tencent`、`cnpm`、`huawei`、`npmMirror`。需要 PATH 上已有 `npm`。

### `sdkvm mrm`

管理 Maven **依赖和插件**的下载镜像，写入 `settings.xml` 里的 `<mirror>`，风格接近 `sdkvm nrm`。不调用 `mvn`，不写账号密码，也不改 `MAVEN_HOME`。与 `sdkvm maven mirror`（只改 Maven **安装包**地址）无关。

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

内置名：`official`（删掉 sdkvm 标记块，恢复你原来的 mirror）、`aliyun`（别名 `ali`，聚合仓 `repository/public`）、`huawei`、`tencent`。只改 `<!-- >>> sdkvm mrm >>> -->` 标记块，其中 `id=sdkvm`、`mirrorOf=*`。路径优先级：`--settings` > 环境变量 `SDKVM_M2_SETTINGS` > `config.mavenSettings` > `~/.m2/settings.xml`。前两项不写入配置。路径不是 Maven 默认位置时，`use` 会提示 `mvn -s <path>`。

## 版本语法

`install`、`use`、`uninstall` 共用下表。未列出的组合会被拒绝并给出改写提示。

| 语法             | Java             | Go                  | Flutter                        | Node.js                        | Maven                          | Miniconda                | Python                         | 示例                                                              |
| ---------------- | ---------------- | ------------------- | ------------------------------ | ------------------------------ | ------------------------------ | ----------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `<major>`        | 该大版本最新补丁 | —                   | —                              | 该 major 最新                  | 该 major 最新稳定版            | 该 major 最新           | 该 major 最新稳定版            | `21`、`22`、`3`、`26`                                             |
| `<major.minor>`  | —                | 该 minor 线最新补丁 | stable 通道该 minor 线最新补丁 | —                              | 该 minor 线最新稳定版          | 该 minor 线最新         | 该 minor 线最新稳定版          | `1.24`、`3.47`、`3.9`、`3.12`、`26.7`                             |
| `lts`            | 最新 LTS 大版本  | —                   | —                              | 最新 LTS 线（当前 24 Krypton） | —                              | —                       | —                              | `lts`                                                             |
| `latest`         | —                | 最新稳定版          | stable 最新，不含 beta         | 最新 Current                   | 最高稳定版，不含预发布         | 当前平台最新安装器      | 最新稳定版，不含预发布         | `latest`                                                          |
| `<full-version>` | 精确版本或前缀   | 精确版本            | 精确版本，可含 prerelease      | 精确版本                       | 精确版本，可含预发布           | 构建号或 Python 标签    | 精确版本，可含预发布           | `21.0.5+11`、`1.24.5`、`22.20.0`、`3.12.7`、`py313_26.7.1-1`      |
| `<vendor>-…`     | 限定发行版       | 同左                | 同左                           | 同左                           | 同左                           | 同左                    | 同左                           | `zulu-21`、`maven-3.9.9`、`cpython-3.12.7`                        |

匹配规则：

- `21`、`1.24`、`3.47`、`22`、`3`、`3.9`、`3.12` 匹配该线已安装或可安装的最新补丁。
- Java 的 `21.0.5` 做前缀匹配，可以命中 `21.0.5+11`。Go、Flutter、Node.js、Maven、Python 的精确版本按全串匹配。
- Flutter 的 `latest` 与 `3.47` 只解析 stable。安装 beta 需要完整 prerelease，例如 `3.49.0-0.1.pre`。
- Maven 只收录 3.0 及以上的稳定版 `x.y.z`。`latest`、`3`、`3.9` 不含预发布；安装 `4.0.0-rc-4` 这类版本必须写完整串。Maven 没有 `lts`。
- Java 的 `lts` 与 Adoptium 列表对齐，当前为 8 / 11 / 17 / 21 / 25。Node.js 的 `lts` 取官方 `index.json` 里最新带 LTS 代号的条目。
- Node.js 不接受 `22.20` 这种两段式，应写成 `22` 或 `22.20.0`。
- Java 接受旧式 major 写法：`1.8` 等价于 `8`。`1.8.0_392` 这类带更新号的写法不受支持，请改用 `8`（最新）或 `8.0.392+b06`（精确构建）。
- Miniconda 版本如 `py313_26.7.1-1`。`26` 取该 major 最新，`26.7` 取该 minor 线最新，`26.7.1-1` 取该构建里最高的 Python，`py313` 取该 Python 的最新安装器，`py313_26.7.1-1` 精确到 Python 和构建。没有 `lts`。忽略文件名里的 `latest` 别名。
- Python 版本如 `3.12.7`。`3`、`3.12`、`latest` 只取稳定版；`3.14.0rc2` 这类预发布必须写完整串。没有 `lts`。构建日期 `+20260924` 不进入目录名。这是 CPython，不改 conda 频道。Python 和 Miniconda 都 `use` 之后，shell 配置里后写入的块在 `PATH` 上靠前。
- 省略厂商前缀时使用默认发行版。只有 Java 可以配置默认厂商，见[配置文件](#配置文件)。

## 工作原理

### 目录布局

数据根目录是 `~/.sdkvm`（Windows 为 `%USERPROFILE%\.sdkvm`）。`SDKVM_HOME` 可覆盖。

```
~/.sdkvm/
├── jdks/            # Java：temurin-21.0.12.1
├── gos/             # Go：golang-1.24.5
├── flutters/        # Flutter：flutter-3.47.5
├── nodes/           # Node.js：nodejs-22.20.0
├── mavens/          # Maven：maven-3.9.9
├── minicondas/       # Miniconda：miniconda-py313_26.7.1-1
├── pythons/          # Python：cpython-3.12.7
├── current-java     # JAVA_HOME 链接（Windows 为 junction）
├── current-go
├── current-flutter
├── current-node
├── current-maven
├── current-miniconda
├── current-python
├── runtime/         # 脚本安装的 CLI 运行时，与 current-node 隔离
├── cli/             # 脚本安装的 CLI 包
├── bin/             # 脚本安装的入口 sdkvm（需加入 PATH）
├── config.json
├── cache/           # 下载中转，安装成功后删除
└── tmp/             # 解压临时目录，同样会删除
```

解压后的大致体积：Java 约 300 MB，Go 约 250 MB，Node.js 约 100 MB（含捆绑 npm），Maven 约 10 MB，Python 归档约 20–40 MB，Miniconda 安装器约 150 MB，Flutter 数 GB（压缩包约 1–2.2 GB）。

### 切换机制

macOS / Linux 上，`current-*` 是指向当前版本目录的符号链接。首次 `use` 会向 shell 配置追加带标记的块：zsh 写入 `~/.zshrc`，bash 写入 `~/.bash_profile` 或 `~/.bashrc`。七种 SDK 各一块。Miniconda 的块还会 source `conda.sh`，这样 `conda activate` 可用。Python 和 Miniconda 都切换之后，后写入的块先进入 `PATH`。

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

环境变量指向链接。之后的 `use` 只改链接，新终端会读到新值。

Windows 上，七个 `current-*` 都是 junction。`use` 把用户级环境变量写成 `REG_EXPAND_SZ`，保留 `%VAR%` 引用，避免 `setx` 的 1024 字符截断。PATH 追加 `%JAVA_HOME%\bin`、`%GO_HOME%\bin`、`%FLUTTER_HOME%\bin`、`%MAVEN_HOME%\bin`。Node.js 的 Windows 归档没有 `bin/`，PATH 项是 `%NODE_HOME%` 本身。Miniconda 追加 `%MINICONDA_HOME%`、`%MINICONDA_HOME%\Scripts`、`%MINICONDA_HOME%\Library\bin`。Python 追加 `%PYTHON_HOME%`（`python.exe`）和 `%PYTHON_HOME%\Scripts`（`pip.exe`）。需要重开终端或重启 IDE。PowerShell 里的 `conda activate` 不在本次范围内。

## 配置

### 配置文件

路径：`~/.sdkvm/config.json`。文件损坏时会备份为 `config.json.bak` 并回退默认值。

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

| 字段            | 说明                                       | 默认值      |
| --------------- | ------------------------------------------ | ----------- |
| `version`       | schema 版本                                | `1`         |
| `defaultVendor` | Java 省略厂商前缀时的发行版                | `"temurin"` |
| `mirror`        | 厂商 id 到镜像根 URL。id 在全部 SDK 中唯一 | `{}`        |
| `npmRegistries` | `sdkvm nrm add` 写入的自定义 npm 源        | `{}`        |
| `mavenRegistries` | `sdkvm mrm add` 写入的自定义 Maven 依赖仓库 | `{}`     |
| `mavenSettings` | 自定义 `settings.xml` 绝对路径；空串用默认文件 | `""`     |

### 环境变量

| 变量                 | 说明                                                    |
| -------------------- | ------------------------------------------------------- |
| `SDKVM_HOME`         | 数据根目录，默认 `~/.sdkvm`                             |
| `SDKVM_MIRROR`       | 临时镜像，优先级高于配置文件，不写入配置                |
| `SDKVM_M2_SETTINGS`  | 本次 `sdkvm mrm` 使用的 settings.xml，不写入配置    |
| `SDKVM_QUIET`        | 非空时抑制 info 与 warn                                 |
| `SDKVM_NODE_DIST`    | 安装脚本使用的 Node 发行根 URL                          |
| `SDKVM_RELEASE_BASE` | 安装脚本与 `sdkvm upgrade` 使用的 GitHub Release 根 URL |
| `SDKVM_RUNTIME_NODE` | 安装脚本内置的 Node 版本，默认 `22.20.0`                |

镜像优先级：`SDKVM_MIRROR` > `config.mirror[<vendor>]` > 官方源。详见[镜像与 npm 源](#镜像与-npm-源)。

## 镜像与 npm 源

三套独立能力，不要混用：

|        | `sdkvm mirror`                                      | `sdkvm nrm`         | `sdkvm mrm`                          |
| ------ | --------------------------------------------------- | ------------------- | ------------------------------------ |
| 改什么 | JDK / Go / Flutter / Node / Maven / Miniconda / Python 的下载地址 | **npm 包** registry | Maven **依赖 / 插件**仓库            |
| 影响   | `sdkvm … install`                                   | `npm install`       | `mvn` 解析依赖（读 `settings.xml`） |
| 作用域 | 按 SDK 类型分别设置                                 | 用户级全局          | 一份 `settings.xml`                  |

### SDK 安装包镜像

推荐按类型选用内置站（`use` 只写当前类型对应的 vendor；别名：`tsinghua`→`tuna`，`ali`→`aliyun`）：

```sh
sdkvm mirror use nju
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna
```

`sdkvm miniconda mirror` 只切换 sdkvm 下载 Miniconda 本身的来源。不写 `.condarc`，也不改 `conda install` 的频道。阿里云没有 Miniconda 安装器目录，所以不在列表里。`sdkvm python mirror` 把 `github.com/astral-sh/python-build-standalone/releases/download` 换成镜像根，保留 `/{tag}/{filename}`。`latest-release.json` 和 `SHA256SUMS` 仍走官方。国内站没有核对过这条路径，所以没有预设站。

| 站点       | Java (temurin) | Go         | Flutter    | Node.js               | Maven      | Miniconda | Python |
| ---------- | -------------- | ---------- | ---------- | --------------------- | ---------- | -------- | ------ |
| `nju`      | ✓              | ✓          | ✓          | ✓                     | —          | ✓        | —      |
| `tuna`     | ✓              | —          | ✓          | —（归档不全，未收录） | —          | ✓        | —      |
| `aliyun`   | —              | ✓          | —          | ✓                     | ✓          | —        | —      |
| `huawei`   | —              | —          | —          | ✓                     | ✓          | —        | —      |
| `ustc`     | —              | —          | —          | —                     | —          | ✓        | —      |
| `official` | 清空本类型     | 清空本类型 | 清空本类型 | 清空本类型            | 清空本类型 | 清空本类型 | 清空本类型 |

手填 URL 或临时覆盖：

```sh
sdkvm go mirror set golang https://golang.google.cn/dl
sdkvm python mirror set cpython https://mirror.example/python-build-standalone
SDKVM_MIRROR=https://golang.google.cn/dl sdkvm go install 1.24
```

优先级：`SDKVM_MIRROR` > `config.mirror[<vendor>]` > 官方源。镜像只替换归档下载地址；版本元数据与校验和优先走官方 API。官方校验源不可达、且校验文件是归档旁路（Maven `.sha512`、Temurin `.json`）时，改拉镜像上的同一文件再核对。Maven 3.8 及更早没有 `.sha512`，改用 Central 上的 `.sha1`。两边都拿不到，或哈希不一致，安装仍失败。

| 厂商           | 说明                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Temurin        | Adoptium 目录结构；已验证 [NJU](https://mirrors.nju.edu.cn/adoptium)、[TUNA](https://mirrors.tuna.tsinghua.edu.cn/Adoptium)     |
| Go             | 文件名拼在根 URL 后；如 `nju` / `aliyun`                                                                                        |
| Flutter        | 桶前缀替换；已验证 [NJU](https://mirror.nju.edu.cn/flutter/flutter_infra_release)。不要用 `storage.flutter-io.cn`（无发布清单） |
| Node.js        | 前缀替换；已验证 [NJU](https://mirror.nju.edu.cn/nodejs-release)。不要用 TUNA nodejs-release（缺归档）                          |
| Maven          | Central 路径前缀替换；已验证 [阿里云 central](https://maven.aliyun.com/repository/central)、[华为云 maven](https://repo.huaweicloud.com/repository/maven)。较新版本用 `.sha512`，3.8 及更早用 `.sha1` |
| Miniconda  | 安装器目录前缀替换；已验证 NJU / TUNA / USTC。只换 sdkvm 下载 Miniconda 的地址 |
| Python     | GitHub `releases/download` 前缀替换，保留 `/{tag}/{filename}`。清单不走镜像。暂无核对过的预设站 |
| Zulu、Corretto | 官方 CDN 直发，暂不支持镜像                                                                                                     |

### npm registry

```sh
sdkvm nrm use taobao   # 国内常用
sdkvm nrm use npm      # 恢复官方
sdkvm nrm test         # 测延迟
```

### Maven 依赖镜像

`sdkvm mrm` 在 `settings.xml` 里写入或删除一段标记块（`mirrorOf=*`，`id=sdkvm`）。`use official` 只删这段，文件里其它 mirror、server、profile 保持不变。阿里云这里用聚合仓 `repository/public`，和安装包镜像 `repository/central` 不是同一个地址。

```sh
sdkvm mrm use aliyun    # 依赖走阿里云 public
sdkvm mrm use official  # 去掉 sdkvm 这段 mirror
sdkvm mrm settings ~/work/settings.xml
mvn -s ~/work/settings.xml compile   # 非默认路径时需要自己带 -s
```

## 安全性

- 下载地址来自官方 API：Adoptium、Azul Metadata、Corretto、go.dev/dl、Flutter releases、nodejs.org/dist `index.json`、Maven Central `maven-metadata.xml`。不抓取搜索页。
- 归档按块计算 SHA-256。Go、Flutter、Node.js（官方 `SHASUMS256.txt`）校验失败即中止。Maven 再对照 `.sha512`；Central 没有该文件时（3.8 及更早）改用 `.sha1`。校验源不可达时：官方下载警告并继续；走镜像时先试官方旁路，失败再试镜像上的同一文件。两边都拿不到，或哈希不一致，安装失败。
- 解压后检查单根目录和可执行文件，并且只解压到新的空目录。
- 安装与 `sdkvm upgrade` 持有 `~/.sdkvm/.lock`，避免并发写互相覆盖。

## 常见问题

### `use` 之后命令还是旧版本

rc 块在新终端或 `source ~/.zshrc` 之后生效。IDE 需要重启。先用 `sdkvm current` 确认链接已经切换。Windows 上注册表已更新，已打开的终端读不到新值。

### 环境变量从 `GOROOT` / `FLUTTER_ROOT` 改名了

现在统一为 `GO_HOME`、`FLUTTER_HOME`（与 `JAVA_HOME` / `NODE_HOME` 对齐）。升级 CLI 后请对已启用的 SDK 再执行一次 `use`，并删除用户环境里残留的旧变量名（Windows 注册表 / 旧 rc 手工行）。

### fish 或 nushell

自动写入只支持 zsh 和 bash。按[切换机制](#切换机制)改写成对应语法。fish 示例：

```fish
set -gx JAVA_HOME $HOME/.sdkvm/current-java
set -gx GO_HOME $HOME/.sdkvm/current-go
set -gx FLUTTER_HOME $HOME/.sdkvm/current-flutter
set -gx NODE_HOME $HOME/.sdkvm/current-node
set -gx MAVEN_HOME $HOME/.sdkvm/current-maven
fish_add_path $JAVA_HOME/bin $GO_HOME/bin $FLUTTER_HOME/bin $NODE_HOME/bin $MAVEN_HOME/bin
```

### Flutter 下载慢或中断

先 `sdkvm flutter mirror use nju`（或 `tuna`）。超时条件是 60 秒没有数据，稳定的慢速不会中断。中断后直接重跑 `install`，不会留下半成品。

### 安装 Flutter beta

使用完整 prerelease，例如 `sdkvm flutter install 3.49.0-0.1.pre`。`latest` 和 `3.47` 只解析 stable。

### CLI 会不会被自己管理的 Node 影响

脚本安装用 `~/.sdkvm/runtime` 启动 CLI，`sdkvm node use` 不影响它。npm 全局安装跟随 `PATH` 上的 `node`；切到 18.15 以前时 CLI 可能无法启动，`sdkvm node use 22` 可以恢复。

### `mirror`、`nrm`、`mrm` 有什么区别

见[镜像与 npm 源](#镜像与-npm-源)：`mirror` 管 SDK 安装包下载，`nrm` 管 npm 拉包，`mrm` 管 Maven 依赖仓库（`settings.xml`）。

### 代理

当前不读取 `HTTPS_PROXY`。可以使用系统级透明代理。

### CI 或多用户隔离

设置 `SDKVM_HOME=/path/to/dir`。安装、链接和配置都跟随该目录。

## 卸载

npm 安装：

```sh
npm uninstall -g sdkvm
```

pnpm、yarn、bun 使用各自的全局卸载命令。

脚本安装只删除 shim 和 CLI 运行时，已安装的 SDK 还在：

```sh
rm -rf ~/.sdkvm/bin ~/.sdkvm/cli ~/.sdkvm/runtime
```

Windows 对应删除 `%USERPROFILE%\.sdkvm\bin\sdkvm.cmd`，以及 `%USERPROFILE%\.sdkvm\cli` 与 `%USERPROFILE%\.sdkvm\runtime`，并从用户 PATH 移除 `%USERPROFILE%\.sdkvm\bin`。

确认不再需要已安装的 JDK、Go、Flutter、Node.js、Maven、Miniconda、Python 之后，再删除数据目录：

```sh
rm -rf ~/.sdkvm
```

同时删除 shell 配置里：

- `# >>> sdkvm path >>>` … `# <<< sdkvm path <<<`
- 各 SDK 的 `>>> sdkvm java|go|flutter|node|maven|miniconda|python init >>>` … `<<< … <<<`

Windows 还需要在系统设置中删除 `JAVA_HOME`、`GO_HOME`、`FLUTTER_HOME`、`NODE_HOME`、`MAVEN_HOME`、`MINICONDA_HOME`、`PYTHON_HOME`，并从用户 PATH 移除 `%JAVA_HOME%\bin`、`%GO_HOME%\bin`、`%FLUTTER_HOME%\bin`、`%NODE_HOME%`、`%MAVEN_HOME%\bin`、`%MINICONDA_HOME%`、`%MINICONDA_HOME%\Scripts`、`%MINICONDA_HOME%\Library\bin`、`%PYTHON_HOME%`、`%PYTHON_HOME%\Scripts`。

## 开发

```sh
git clone https://github.com/QInJ1995/sdkvm.git && cd sdkvm
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` 用 tsup 生成 `dist/index.js`。本地试用：`node dist/index.js`。

```
src/
├── cli/       # install / use / ls / uninstall / mirror / nrm / upgrade
├── core/      # 版本解析、注册表、配置、文件锁
├── sdk/       # java / go / flutter / node / maven / miniconda / python 的目录、环境变量、版本语法
├── vendor/    # temurin / zulu / corretto / golang / flutter / nodejs / maven / miniconda / cpython 与镜像改写
├── fs/        # 解压、目录归一化、链接
├── shell/     # rc 写入、Windows 注册表
├── net/       # fetch、流式下载、校验
└── ui/        # 日志与进度
```

新增一种语言：在 `src/vendor/` 实现 `listMajors` 与 `resolve`，在 `src/sdk/` 增加类型描述（安装目录、current 链接、环境变量、版本语法、二进制路径），并注册到 `sdk/index.ts`。install / use / ls / uninstall / mirror，以及 rc 与注册表写入会跟着生效。

## 许可证

[MIT](./LICENSE) © 秦佬湿
