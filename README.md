<div align="center">

# sdkvm

**跨平台多语言 SDK 版本管理器**

[![npm version](https://img.shields.io/npm/v/sdkvm)](https://www.npmjs.com/package/sdkvm)
[![CI](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml/badge.svg)](https://github.com/QInJ1995/sdkvm/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/sdkvm)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.15-green)](./package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#系统要求)

中文 | [English](./README.en.md)

统一安装、切换与卸载 **Java JDK**、**Go 工具链**、**Flutter SDK**、**Node.js 运行时**、
**Apache Maven**、**Miniconda** 与 **CPython**。

</div>

---

## 目录

- [概述](#概述)
- [主要特性](#主要特性)
- [支持的 SDK](#支持的-sdk)
- [系统要求](#系统要求)
- [安装](#安装)
- [升级 CLI](#升级-cli)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [版本规格](#版本规格)
- [退出码](#退出码)
- [工作原理](#工作原理)
- [配置](#配置)
- [镜像与软件源](#镜像与软件源)
- [安全模型](#安全模型)
- [故障排查](#故障排查)
- [卸载](#卸载)
- [参与开发](#参与开发)
- [许可证](#许可证)

## 概述

`sdkvm` 是一个用 Node.js 编写的命令行工具,为多语言开发环境提供统一的版本管理:
在官方源或镜像站解析、下载、校验并安装 SDK,通过一个符号链接完成版本切换,
不搬移已安装的文件,也不向系统目录写入任何内容。

设计目标:

- **隔离**——所有版本安装在独立的数据根目录(默认 `~/.sdkvm`)下,每种 SDK 一套目录、
  一个 `current-*` 链接、一组环境变量,互不覆盖,支持多版本并存。
- **可逆**——对宿主环境只做最小修改:macOS / Linux 上只追加带标记的 shell 初始化块,
  Windows 上只写用户级环境变量;卸载时可以精确清除。
- **可靠**——下载流式计算哈希、镜像与安装器强制校验、安装原子落位、失败不留半成品、
  多进程互斥由文件锁保证。
- **可扩展**——新增一种语言只需实现一个厂商模块,`install` / `use` / `ls` / `uninstall`
  / `mirror` 及 rc、注册表写入随之生效。

## 主要特性

- 七类 SDK、三个 JDK 发行版(Temurin / Zulu / Corretto)统一管理。
- 版本规格支持 `lts`、`latest`、大版本线、精确版本与厂商前缀,`install`、`use`、
  `uninstall` 三条命令共用同一套语法。
- 跨平台:macOS(Apple Silicon / Intel)、主流 Linux(x64 / aarch64)、Windows 10+。
  Windows 上使用 junction 与 `REG_EXPAND_SZ` 用户环境变量,规避 `setx` 截断。
- 完整性校验:归档在下载过程中流式计算 SHA-256,与官方清单比对;Maven 校验官方
  SHA-512(旧版本回退 SHA-1);走镜像或执行安装器时强制要求可核对的哈希。
- 下载加速:内置国内镜像站(nju / tuna / aliyun / huawei / ustc),按 SDK 类型独立配置;
  另含 npm registry(`nrm`)与 Maven 依赖镜像(`mrm`)两套独立的管理命令。
- 原子安装:先解压到临时目录并校验目录结构,再一次性落位;校验失败或中断不残留文件。
- 并发安全:安装、切换、卸载、升级共用排他文件锁,进程存活探测加心跳,崩溃后自动恢复。
- 免预装 Node.js:官方安装脚本自带隔离运行时,数据与入口集中在 `SDKVM_HOME`。

## 支持的 SDK

| SDK | 来源 | 版本能力 | 说明 |
| --- | --- | --- | --- |
| Java | [Temurin](https://adoptium.net/)、[Zulu](https://www.azul.com/downloads/)、[Corretto](https://aws.amazon.com/corretto/) | `lts` 当前为 8 / 11 / 17 / 21 / 25;支持精确版本与 `+build` | 三发行版并存,`use` 可跨发行版切换;Corretto 仅发布 LTS 线;Linux 上 Zulu 只选 glibc 构建(musl 变体不参与匹配) |
| Go | [go.dev/dl](https://go.dev/dl/) | 全历史稳定版 | `latest`、`1.24`、`1.24.5` |
| Flutter | 官方发布清单 | stable / beta | macOS 双架构;Linux / Windows 仅 x64;beta 需完整 prerelease |
| Node.js | [nodejs.org/dist](https://nodejs.org/dist) | `lts`(当前 24 Krypton)/ `latest` / major 线 / 精确版本 | npm 随所选版本一起切换 |
| Maven | [Maven Central](https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/) | 3.0 起全部稳定版,预发布需精确版本 | 无 `lts` 别名 |
| Miniconda | [repo.anaconda.com/miniconda](https://repo.anaconda.com/miniconda/) | `26` / `26.7` / `py313` / `py313_26.7.1-1` / `latest` | 安装器约 150 MB,静默安装视为接受 [Miniconda 条款](https://www.anaconda.com/legal) |
| Python | [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | `3` / `3.12` / `3.12.7` / `3.14.0rc2` / `latest` | 预编译 CPython,归档约 20–40 MB,与 Miniconda 互不影响 |

## 系统要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 18.15 | npm 安装方式需要。安装脚本自带隔离运行时,不要求预装 |
| 操作系统 | — | macOS(Apple Silicon / Intel)、主流 Linux、Windows 10+ |
| 解压工具 | 系统自带 | macOS / Linux 使用 `tar`;Windows 使用 bsdtar,缺失时回退 PowerShell `Expand-Archive` |

平台限制:

- Linux 解压 Flutter(`.tar.xz`)需要 `xz`(`xz-utils`),主流发行版默认自带。
- Flutter 官方在 Linux / Windows 只发布 x64 归档;ARM Linux 与 ARM Windows 无法安装
  Flutter。macOS 两种架构均支持。
- `flutter` 命令首次运行会构建内部缓存,耗时较久属正常现象。
- Miniconda:Windows 安装路径不能含空格(必要时将 `SDKVM_HOME` 指向无空格目录);
  Windows 仅 x64,macOS 双架构,Linux 支持 x64 与 aarch64,较新版本可能只发布其中
  部分平台。安装器下载后必须带有可核对的 SHA-256 才会执行(无论是否走镜像)。
- Python 使用 python-build-standalone 的 `install_only_stripped` 归档(缺失时回退
  `install_only`),覆盖三大系统的 x64 与 aarch64;不安装 free-threaded、musl 构建,
  也不选 `x86_64_v2` / `v3` / `v4` 变体。列表反映最新一次构建快照,精确版本在最新
  快照缺失时自动回退查询最近几个历史 release 标签。

## 安装

### 安装脚本(推荐)

无需预装 Node.js:脚本下载一个仅供 CLI 使用的隔离运行时,数据与入口全部位于
`SDKVM_HOME`(默认 `~/.sdkvm`)下,之后用 `sdkvm upgrade` 升级。

前提:仓库已有包含 `sdkvm.tgz` 与 `SHA256SUMS` 的
[GitHub Release](https://github.com/QInJ1995/sdkvm/releases)(推送 `v*` tag 后由 CI 上传)。

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

Windows(PowerShell):

```powershell
irm https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.ps1 | iex
```

脚本执行内容:

1. 下载 Node.js 22.20.0 到 `$SDKVM_HOME/runtime`(仅用于启动 CLI,
   `sdkvm node use` 不会改动它),并按 SHA-256 清单校验。
2. 从 GitHub Release 下载 `sdkvm.tgz`,校验 SHA-256 后解压到 `$SDKVM_HOME/cli`,
   采用"先解压校验、再原子替换"的流程,失败时保留旧版本。
3. 写入入口 `$SDKVM_HOME/bin/sdkvm`(Windows 为 `%SDKVM_HOME%\bin\sdkvm.cmd`),
   并把该目录加入 shell 配置(zsh → `~/.zshrc`;bash → macOS `~/.bash_profile`、
   其它系统 `~/.bashrc`)或 Windows 用户 PATH,同时广播环境变更通知。

安装完成后重开终端(或 `source` 对应 rc 文件),验证:

```console
$ sdkvm version
1.0.6
```

自定义数据根目录时,**必须在安装命令的环境里显式携带 `SDKVM_HOME`**
(`curl | sh` 不会读取 `~/.zshrc`):

```sh
SDKVM_HOME=/Volumes/Develop/sdkvm \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

网络受限环境可覆盖下载前缀:

```sh
SDKVM_NODE_DIST=https://npmmirror.com/mirrors/node \
SDKVM_RELEASE_BASE=https://github.com/QInJ1995/sdkvm/releases \
  curl -fsSL https://raw.githubusercontent.com/QInJ1995/sdkvm/main/install.sh | sh
```

### npm / pnpm / yarn / bun(备选)

适合本机已有 Node.js >= 18.15、并希望由包管理器统一维护全局工具的场景。
CLI 依赖 `PATH` 上的 `node`;若之后切换到低于 18.15 的 Node,CLI 可能无法启动
(`sdkvm node use 22` 可恢复)。

```sh
npm install -g sdkvm
pnpm add -g sdkvm
yarn global add sdkvm
bun add -g sdkvm
```

## 升级 CLI

| 安装方式 | 命令 | 影响范围 |
| --- | --- | --- |
| 安装脚本(推荐) | `sdkvm upgrade` | 仅替换 `$SDKVM_HOME/cli`;runtime 与已安装 SDK 不变 |
| npm 等 | `npm update -g sdkvm` | 仅更新 CLI;pnpm / yarn / bun 使用各自的全局更新命令 |

数据目录与 CLI 版本无关。脚本安装也可以随时重新执行安装脚本完成升级。

## 快速开始

Java 既可用裸命令(`sdkvm install` 等价于 `sdkvm java install`),也可用子命令;
Go、Flutter、Node.js、Maven、Miniconda、Python 使用 `sdkvm <type>` 子命令组。

```sh
# 可选:网络加速(按 SDK 类型独立设置,互不影响)
sdkvm mirror use nju              # Java(Temurin)
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna   # 仅 sdkvm 下载 Miniconda 本身的地址
sdkvm nrm use taobao              # 仅影响 npm install 拉包
sdkvm mrm use aliyun              # 仅影响 mvn 拉依赖(写入 settings.xml)

# Java
sdkvm install lts
sdkvm use 25
java -version

# Go
sdkvm go install 1.24
sdkvm go use 1.24
go version

# Flutter(stable)
sdkvm flutter install 3.47
sdkvm flutter use 3.47
flutter --version

# Node.js(npm 随该版本一起切换)
sdkvm node install lts
sdkvm node use 24
node --version

# Maven(需要 JAVA_HOME,可先 sdkvm java use)
sdkvm maven install 3.9
sdkvm maven use 3.9
mvn -version

# Miniconda(安装器约 150 MB)
sdkvm miniconda install 26.7
sdkvm miniconda use 26.7
conda --version

# Python(预编译 CPython,与 Miniconda 互不影响)
sdkvm python install 3.12
sdkvm python use 3.12
python --version

# 查看与移除
sdkvm current
sdkvm java install 21 --vendor zulu
sdkvm java use zulu-21
sdkvm ls
sdkvm go ls
sdkvm uninstall zulu-21
```

首次 `use` 之后请**重开终端**,或在 macOS / Linux 上执行 `source ~/.zshrc`
(bash 则 source 对应 rc 文件);IDE 需要重启才能读到新的环境变量。

日常工作流只需三条命令:`install` → `use` → `current` / `ls`。

## 命令参考

### 命令组结构

| 命令组 | 说明 |
| --- | --- |
| `sdkvm install / use / ls / current / uninstall / mirror` | Java 的裸命令形式,与 `sdkvm java …` 完全等价 |
| `sdkvm java …` | Java 子命令组(与裸命令等价) |
| `sdkvm go / flutter / node / maven / miniconda / python …` | 对应 SDK 的同一套子命令组 |
| `sdkvm nrm …` | npm registry 管理 |
| `sdkvm mrm …` | Maven 依赖镜像管理 |
| `sdkvm version` / `sdkvm upgrade` | CLI 自身信息与升级 |

每个 SDK 子命令组都包含 `install`、`use`、`ls`(别名 `list`)、`current`、
`uninstall`、`mirror` 六个子命令,参数与下文逐条说明一致。

### `sdkvm install <version>`

解析版本规格,下载归档(下载过程中流式计算 SHA-256),校验,解压到临时目录,
通过目录结构检查后原子落位到安装目录。

```console
$ sdkvm install 21
sdkvm resolving Adoptium Temurin 21 for mac/aarch64 ...
sdkvm downloading https://github.com/adoptium/temurin21-binaries/releases/...
↓ Temurin 21.0.12.1  160.2MB / 200.4MB
sdkvm installed Temurin 21.0.12.1 → ~/.sdkvm/jdks/temurin-21.0.12.1
sdkvm switch to it: sdkvm use 21
```

| 选项 | 说明 |
| --- | --- |
| `--vendor <id>` | 限定发行版。Java:`temurin`(默认)/ `zulu` / `corretto`;Go 为 `golang`,Flutter 为 `flutter`,Node.js 为 `nodejs`,Maven 为 `maven`,Miniconda 为 `miniconda`,Python 为 `cpython` |
| `--force` | 已安装时删除并重装;默认跳过已安装版本 |

行为细节:

- 安装成功后提示的切换命令是"指回这份安装"的最短规格;当同 major 存在更新的已装
  版本时,提示会自动带上厂商前缀(如 `sdkvm use zulu-21.0.5+11`),避免裸
  `use 21` 被其它发行版的更新版本抢占。
- 校验失败或解压异常时,临时目录与缓存中的半成品会被清除。
- 下载超时条件是 60 秒无数据(空闲超时),不是总时长上限。
- 归档包含越界路径(zip-slip)或外指符号链接时拒绝安装。

### `sdkvm use <version>`

在**已安装**的版本中匹配,更新对应的 `current-*` 链接,并保证环境变量
(`JAVA_HOME` / `GO_HOME` / `FLUTTER_HOME` / `NODE_HOME` / `MAVEN_HOME` /
`MINICONDA_HOME` / `PYTHON_HOME`)与 `PATH` 生效。

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

| 选项 | 说明 |
| --- | --- |
| `--vendor <id>` | 将匹配范围限定到一个发行版 |

匹配规则:

- 不带厂商前缀的 `use <major>`(如 `use 21`)选择该 major 下**全部发行版中**最新的
  已安装版本;需要固定某个发行版时,用 `vendor-` 前缀或 `--vendor`。
- Java 的精确版本按前缀匹配:`21.0.5` 可以命中 `21.0.5+11`;反向亦可
  (`use zulu-21.0.5+11` 命中目录名不带 build 号的 `zulu-21.0.5`)。

macOS / Linux 上,首次 `use` 向 shell 配置追加带标记的初始化块(见
[版本切换](#版本切换)),重开终端或 `source` rc 文件后生效;之后的切换只改链接。
IDE 需要重启。Maven 需要 JDK:没有 `JAVA_HOME` 时会提示先执行 `sdkvm java use`。

### `sdkvm ls`

列出已安装版本,`→` 标记当前版本。别名 `list`。

```console
$ sdkvm go ls
→ golang-1.24.5
  golang-1.23.9
```

| 选项 | 说明 |
| --- | --- |
| `-r, --remote` | 并行拉取该类型全部厂商的可安装版本线;默认显示最近 12 条线,更老的版本按精确名称安装 |
| `--vendor <id>` | 将 `--remote` 输出限定为一个厂商 |

```console
$ sdkvm flutter ls -r

# Flutter (official)
  flutter-3.47  latest: flutter-3.47.5
  flutter-3.44  latest: flutter-3.44.9

# install with: sdkvm flutter install <name>
```

`-r` 模式下个别厂商失败会输出警告并继续;全部厂商失败时命令以退出码 1 结束。

### `sdkvm current`

显示全部已启用 SDK 的当前版本与指向。未安装的类型不显示。裸命令查看 Java,
`sdkvm <type> current` 查看对应类型。

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

移除一个已安装版本,语法与 `use` 相同。

| 选项 | 说明 |
| --- | --- |
| `--vendor <id>` | 将匹配范围限定到一个发行版 |

- 卸载**非当前**版本:仅删除该版本目录,其它版本与当前链接不受影响。
- 卸载**当前**版本:先删除目录,再清除对应的 `current-*` 链接——macOS / Linux
  同时移除 rc 文件里该 SDK 的 sdkvm 标记块,Windows 同时清理对应环境变量与用户
  PATH 条目——然后提示选择其它版本。
- 版本不存在时给出已安装版本提示,并以退出码 1 结束。

### `sdkvm mirror [action] [nameOrVendor] [url]`

按 SDK 类型管理**下载该 SDK 安装包的镜像**。既不是 npm 包源,也不是 conda 频道。
Java 用裸命令 `sdkvm mirror`,其余类型用 `sdkvm go|flutter|node|maven|miniconda|python mirror`,
作用域互不影响。

```sh
sdkvm mirror ls
sdkvm mirror use nju
sdkvm go mirror use aliyun
sdkvm node mirror use official   # 恢复该类型官方源
```

| 动作 | 说明 |
| --- | --- |
| `ls` | 列出本类型可用的镜像站与当前选择 |
| `current` / `show` | 显示当前生效的镜像配置 |
| `use <site>` | 切换到内置站(`nju` / `tuna` / `aliyun` / `huawei` / `ustc` / `official`;别名 `tsinghua`→`tuna`、`ali`→`aliyun`),只写入当前类型对应的厂商 |
| `set [vendor] <url>` | 手动设置镜像根 URL |
| `unset` | 清除本类型的手动配置 |

镜像覆盖矩阵与手填示例见[镜像与软件源](#镜像与软件源)。

### `sdkvm nrm <command>`

管理用户级 **npm registry**(`npm install` 的拉包地址),使用方式接近
[nrm](https://github.com/Pana/nrm)。与 `mirror` 完全独立。要求 `PATH` 上有 `npm`
(Windows 上通过 npm 自带的 `npm-cli.js` 调用,不经过 shell)。

| 子命令 | 说明 |
| --- | --- |
| `ls` / `list` | 列出全部 registry,`*` 标记当前 |
| `current` | 打印当前 registry |
| `use <name>` | 切换用户级 registry |
| `add <name> <url>` | 添加自定义 registry |
| `del <name>`(别名 `delete`) | 删除自定义 registry |
| `test [name]` | 探测各 registry 延迟并打印 |

```sh
sdkvm nrm ls
sdkvm nrm use taobao
sdkvm nrm use npm
sdkvm nrm add myprivate http://xxx/registry
sdkvm nrm del myprivate
sdkvm nrm test
```

内置名:`npm`、`yarn`、`taobao`(别名 `npmmirror`)、`tencent`、`cnpm`、`huawei`、`npmMirror`。
`custom` 是保留名,`add` 拒绝使用;`test` 并发探测所有源,仅当全部失败时才以
非零码退出(单个源失败只影响该行输出)。

### `sdkvm mrm <command>`

管理 Maven **依赖与插件**的下载镜像,通过在 `settings.xml` 写入带标记的
`<mirror>` 块实现,使用方式接近 `sdkvm nrm`。不调用 `mvn`,不保存账号密码,
不修改 `MAVEN_HOME`。与 `sdkvm maven mirror`(只改 Maven **安装包**下载地址)无关。

| 子命令 | 说明 |
| --- | --- |
| `ls` / `list` | 列出全部镜像源,`*` 标记当前 |
| `current` | 打印当前镜像源与 settings 路径 |
| `use <name>` | 切换镜像源(写入标记块) |
| `add <name> <url>` | 添加自定义镜像源 |
| `del <name>`(别名 `delete`) | 删除自定义镜像源 |
| `test [name]` | 从各源 GET 一个已知 POM 并打印延迟 |
| `settings [path\|unset]` | 查看 / 设置 / 清除 settings.xml 路径 |

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

内置名:`official`(删除 sdkvm 标记块,恢复原有 mirror 配置)、`aliyun`(别名
`ali`,聚合仓 `repository/public`)、`huawei`、`tencent`。

行为细节:

- 只编辑 `<!-- >>> sdkvm mrm >>> -->` 与 `<!-- <<< sdkvm mrm <<< -->` 之间的内容
  (`id=sdkvm`、`mirrorOf=*`),文件中其它 mirror、server、profile 保持不变;
  `use official` 仅删除该块。
- settings.xml 路径优先级:`--settings` 参数 > 环境变量 `SDKVM_M2_SETTINGS` >
  配置项 `config.mavenSettings` > `~/.m2/settings.xml`;前两项不写入配置。
- 路径不是 Maven 默认位置时,`use` 会提示需要 `mvn -s <path>`。
- 写入采用临时文件加原子替换,并与其它 sdkvm 写操作共用文件锁。
- `custom` 是保留名,`add` 拒绝使用;`test` 仅当所有源都失败时才以非零码退出。
- 标记块不配对(手工编辑残留)时拒绝操作并提示先修复。

### `sdkvm version` 与 `sdkvm upgrade`

```console
$ sdkvm version
1.0.6
```

`sdkvm upgrade`(无参数):脚本安装时从 GitHub Release 下载新版本并原子替换
`$SDKVM_HOME/cli`;npm 等包管理器安装时打印对应包管理器的更新命令。已安装的
SDK 与配置不受影响。升级过程持有文件锁。

## 版本规格

`install`、`use`、`uninstall` 共用同一套版本规格。未列出的组合会被拒绝,
并给出改写建议。

### 总表

| 语法 | Java | Go | Flutter | Node.js | Maven | Miniconda | Python | 示例 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<major>` | 该大版本最新补丁 | — | — | 该 major 最新 | 该 major 最新稳定版 | 该 major 最新 | 该 major 最新稳定版 | `21`、`22`、`3`、`26` |
| `<major.minor>` | — | 该 minor 线最新补丁 | stable 通道该 minor 线最新补丁 | — | 该 minor 线最新稳定版 | 该 minor 线最新 | 该 minor 线最新稳定版 | `1.24`、`3.47`、`3.9`、`3.12`、`26.7` |
| `lts` | 最新 LTS 大版本 | — | — | 最新 LTS 线(当前 24 Krypton) | — | — | — | `lts` |
| `latest` | — | 最新稳定版 | stable 最新,不含 beta | 最新 Current | 最高稳定版,不含预发布 | 当前平台最新安装器 | 最新稳定版,不含预发布 | `latest` |
| `<full-version>` | 精确版本或前缀 | 精确版本 | 精确版本,可含 prerelease | 精确版本 | 精确版本,可含预发布 | 构建号或 Python 标签 | 精确版本,可含预发布 | `21.0.5+11`、`1.24.5`、`22.20.0`、`3.12.7`、`py313_26.7.1-1` |
| `<vendor>-…` | 限定发行版 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | `zulu-21`、`maven-3.9.9`、`cpython-3.12.7` |

### 各 SDK 规则

- **Java**:`lts` 与 Adoptium 列表对齐,当前为 8 / 11 / 17 / 21 / 25。`21.0.5`
  按前缀匹配,可命中 `21.0.5+11`。接受旧式 major 写法:`1.8` 等价于 `8`;
  `1.8.0_392` 这类带更新号的写法不受支持,请改用 `8`(取最新)或
  `8.0.392+b06`(精确构建)。Temurin JDK 8 的精确版本必须带 build 号
  (如 `8.0.504+6`),否则会提示改用 `install 8` 或 `ls -r` 查询。
  Zulu 的 build 号在版本元数据中,安装目录名不带 build,精确匹配自动兼容。
- **Go**:`latest` 取最新稳定版;精确版本按全串匹配。
- **Flutter**:`latest` 与 `<major.minor>` 只解析 stable 通道;安装 beta 需要
  完整 prerelease,例如 `3.49.0-0.1.pre`。
- **Node.js**:不接受 `22.20` 这类两段式写法,请使用 `22` 或 `22.20.0`;
  `lts` 取官方 `index.json` 中最新带 LTS 代号的条目。
- **Maven**:只收录 3.0 及以上的稳定版 `x.y.z`;`latest`、`3`、`3.9` 不含
  预发布,安装 `4.0.0-rc-4` 这类版本必须写完整串;没有 `lts` 别名。
- **Miniconda**:版本形如 `py313_26.7.1-1`。`26` 取该 major 最新,`26.7` 取该
  minor 线最新,`26.7.1-1` 取该构建中最高的 Python,`py313` 取该 Python 的最新
  安装器,`py313_26.7.1-1` 精确到 Python 与构建。没有 `lts`;文件名里的
  `latest` 别名被忽略。
- **Python**:版本形如 `3.12.7`。`3`、`3.12`、`latest` 只取稳定版;`3.14.0rc2`
  这类预发布必须写完整串。没有 `lts`。构建日期 `+20260924` 不进入目录名。
  这是 CPython 发行版,不影响 conda 频道;Python 与 Miniconda 都 `use` 之后,
  shell 配置里后写入的块在 `PATH` 上靠前。

### 厂商前缀

省略厂商前缀时使用默认发行版。只有 Java 的默认发行版可配置
(`config.defaultVendor`,默认 `temurin`),见[配置文件](#配置文件)。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功(允许存在不影响结果的警告) |
| `1` | 运行错误:版本无法解析、校验失败、网络不可达、并发锁冲突、配置损坏等;错误信息附带下一步提示。`ls -r` 在全部厂商拉取失败时同样返回 `1` |

## 工作原理

### 目录布局

数据根目录默认为 `~/.sdkvm`(Windows 为 `%USERPROFILE%\.sdkvm`),可用
`SDKVM_HOME` 覆盖。安装、链接、配置、缓存全部位于该目录内。

```
~/.sdkvm/
├── jdks/             # Java:temurin-21.0.12.1
├── gos/              # Go:golang-1.24.5
├── flutters/         # Flutter:flutter-3.47.5
├── nodes/            # Node.js:nodejs-22.20.0
├── mavens/           # Maven:maven-3.9.9
├── minicondas/       # Miniconda:miniconda-py313_26.7.1-1
├── pythons/          # Python:cpython-3.12.7
├── current-java      # JAVA_HOME 指向的链接(Windows 为 junction)
├── current-go
├── current-flutter
├── current-node
├── current-maven
├── current-miniconda
├── current-python
├── runtime/          # 安装脚本自带的 CLI 运行时,与 current-node 隔离
├── cli/              # 安装脚本部署的 CLI 包
├── bin/              # 安装脚本写入的入口(需在 PATH 上)
├── config.json       # 用户配置
├── .lock             # 排他文件锁
├── cache/            # 下载中转,安装结束后清除
└── tmp/              # 解压临时目录,同样会清除
```

解压后的大致体积:Java 约 300 MB,Go 约 250 MB,Node.js 约 100 MB(含捆绑
npm),Maven 约 10 MB,Python 归档约 20–40 MB,Miniconda 安装器约 150 MB,
Flutter 数 GB(压缩包约 1–2.2 GB)。

### 版本切换

**macOS / Linux**:`current-*` 是指向当前版本目录的符号链接。首次 `use` 向
shell 配置追加带标记的初始化块:zsh 写入 `~/.zshrc`,bash 写入 `~/.bash_profile`
(macOS)或 `~/.bashrc`(其它系统)。七种 SDK 各一块,写入前会检测原有内容编码,
非常规 UTF-8 内容先备份。Miniconda 的块还会 source `conda.sh`,使 `conda activate`
可用。Python 与 Miniconda 都切换后,后写入的块在 `PATH` 上靠前。

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

环境变量指向链接而非具体目录,因此之后的 `use` 只改链接目标,新终端自动读到
新值,无需再次修改 rc 文件。

**Windows**:七个 `current-*` 均为 junction。`use` 将用户级环境变量写为
`REG_EXPAND_SZ` 并保留 `%VAR%` 引用,避免 `setx` 的 1024 字符截断。PATH 追加
`%JAVA_HOME%\bin`、`%GO_HOME%\bin`、`%FLUTTER_HOME%\bin`、`%MAVEN_HOME%\bin`;
Node.js 的 Windows 归档没有 `bin/` 目录,PATH 项为 `%NODE_HOME%` 本身;
Miniconda 追加 `%MINICONDA_HOME%`、`%MINICONDA_HOME%\Scripts`、
`%MINICONDA_HOME%\Library\bin`;Python 追加 `%PYTHON_HOME%`(`python.exe`)与
`%PYTHON_HOME%\Scripts`(`pip.exe`)。写入后广播 `WM_SETTINGCHANGE`,已打开的
终端与 IDE 仍需重启。PowerShell 内的 `conda activate` 不在支持范围内。

### 并发与文件锁

安装、切换、卸载、`upgrade`、`mrm use` 等写操作持有 `~/.sdkvm/.lock` 排他锁:

- 已有操作进行中时,新操作立即失败并提示(`Another sdkvm operation is in
  progress`),附手动清理锁文件的指引。
- 锁文件记录持有进程 PID 与心跳时间戳;持有期间定期刷新心跳。持锁进程已退出、
  或心跳超过 5 分钟未更新时,锁视为过期并被下一个等待者安全接管。
- 误报(确认没有其它 sdkvm 进程在运行)时,按提示删除 `~/.sdkvm/.lock` 即可。

### 下载与完整性校验

- 下载地址一律由官方 API 或官方目录页解析(Adoptium、Azul Metadata、Corretto、
  go.dev/dl、Flutter releases、nodejs.org/dist `index.json`、Maven Central
  `maven-metadata.xml`),不抓取搜索页。
- 归档在下载过程中流式计算 SHA-256,与校验源比对:Go、Flutter、Node.js(官方
  `SHASUMS256.txt`)、Miniconda、Python 校验失败立即中止;Maven 对照官方
  `.sha512`(3.8 及更早无该文件时回退 `.sha1`);Java 各发行版尽力校验——
  Temurin 与 Zulu 的哈希由官方 API 预取,Corretto `21` / `lts` 用官方
  `latest_sha256`;Corretto 精确历史版本无公开校验源,安装时警告并跳过。
- **强制校验**场景:配置了镜像的下载,以及 Miniconda 这类下载后要**执行**的
  安装器——拿不到任何可核对的哈希时直接失败,不降级放行。
- 校验源不可达时的回退顺序:官方旁路文件(如 Temurin `.json`、Maven `.sha512`)
  → 镜像上的同一文件;两侧都不可达或哈希不一致则安装失败。
- 下载空闲超时 60 秒(无数据即断,不限总时长);校验请求自动重试。
- 解压后校验单一根目录与预期可执行文件;解压目标永远是全新的空目录,归档内
  条目(含符号链接)不得越出该目录。任何失败路径都会清除 `cache/` 与 `tmp/`
  中的半成品。

## 配置

### 配置文件

路径:`~/.sdkvm/config.json`。文件损坏时自动备份为 `config.json.bak` 并回退
默认值。所有写入均为临时文件加原子替换。

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

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `version` | 配置 schema 版本 | `1` |
| `defaultVendor` | Java 省略厂商前缀时使用的发行版 | `"temurin"` |
| `mirror` | 厂商 id 到镜像根 URL 的映射;厂商 id 在全部 SDK 中唯一 | `{}` |
| `npmRegistries` | `sdkvm nrm add` 写入的自定义 npm registry | `{}` |
| `mavenRegistries` | `sdkvm mrm add` 写入的自定义 Maven 依赖仓库 | `{}` |
| `mavenSettings` | 自定义 `settings.xml` 绝对路径;空串使用默认位置 | `""` |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `SDKVM_HOME` | 数据根目录,默认 `~/.sdkvm` |
| `SDKVM_MIRROR` | 一次性镜像,优先级高于配置文件,不写入配置 |
| `SDKVM_M2_SETTINGS` | 本次 `sdkvm mrm` 使用的 settings.xml 路径,不写入配置 |
| `SDKVM_QUIET` | 非空时抑制 info 与 warn 日志 |
| `SDKVM_NODE_DIST` | 安装脚本使用的 Node 发行根 URL |
| `SDKVM_RELEASE_BASE` | 安装脚本与 `sdkvm upgrade` 使用的 GitHub Release 根 URL |
| `SDKVM_RUNTIME_NODE` | 安装脚本内置的 Node 版本,默认 `22.20.0` |

镜像优先级:`SDKVM_MIRROR` > `config.mirror[<vendor>]` > 官方源。

## 镜像与软件源

三套独立能力,作用对象不同,不要混用:

| | `sdkvm mirror` | `sdkvm nrm` | `sdkvm mrm` |
| --- | --- | --- | --- |
| 修改对象 | JDK / Go / Flutter / Node / Maven / Miniconda / Python 安装包的下载地址 | **npm 包** registry | Maven **依赖 / 插件**仓库(`settings.xml`) |
| 影响范围 | `sdkvm … install` | `npm install` | `mvn` 依赖解析 |
| 作用域 | 按 SDK 类型分别设置 | 用户级全局 | 一份 `settings.xml` |

### SDK 安装包镜像

推荐按类型选用内置站(`use` 只写当前类型对应的厂商):

```sh
sdkvm mirror use nju
sdkvm go mirror use nju
sdkvm flutter mirror use nju
sdkvm node mirror use nju
sdkvm maven mirror use aliyun
sdkvm miniconda mirror use tuna
```

覆盖矩阵(`✓` 表示该站提供此 SDK 的镜像):

| 站点 | Java (temurin) | Go | Flutter | Node.js | Maven | Miniconda | Python |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nju` | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| `tuna` | ✓ | — | ✓ | —(归档不全,未收录) | — | ✓ | — |
| `aliyun` | — | ✓ | — | ✓ | ✓ | — | — |
| `huawei` | — | — | — | ✓ | ✓ | — | — |
| `ustc` | — | — | — | — | — | ✓ | — |
| `official` | 清空本类型 | 清空本类型 | 清空本类型 | 清空本类型 | 清空本类型 | 清空本类型 | 清空本类型 |

各厂商镜像改写方式与已验证站点:

| 厂商 | 说明 |
| --- | --- |
| Temurin | Adoptium 目录结构;已验证 [NJU](https://mirrors.nju.edu.cn/adoptium)、[TUNA](https://mirrors.tuna.tsinghua.edu.cn/Adoptium) |
| Go | 文件名拼接在根 URL 后;如 `nju` / `aliyun` |
| Flutter | 桶前缀替换;已验证 [NJU](https://mirror.nju.edu.cn/flutter/flutter_infra_release)。不要使用 `storage.flutter-io.cn`(无发布清单) |
| Node.js | 前缀替换;已验证 [NJU](https://mirror.nju.edu.cn/nodejs-release)。不要使用 TUNA nodejs-release(缺归档) |
| Maven | Central 路径前缀替换;已验证[阿里云 central](https://maven.aliyun.com/repository/central)、[华为云 maven](https://repo.huaweicloud.com/repository/maven) |
| Miniconda | 安装器目录前缀替换;已验证 NJU / TUNA / USTC。阿里云无该目录,未收录 |
| Python | GitHub `releases/download` 前缀替换,保留 `/{tag}/{filename}`;清单与校验仍走官方,暂无核对过的预设站,用 `mirror set` 手填 |
| Zulu、Corretto | 官方 CDN 直发,暂不支持镜像 |

手填 URL 或临时覆盖:

```sh
sdkvm go mirror set golang https://golang.google.cn/dl
sdkvm python mirror set cpython https://mirror.example/python-build-standalone
SDKVM_MIRROR=https://golang.google.cn/dl sdkvm go install 1.24
```

镜像只替换归档下载地址;版本元数据与校验和优先走官方 API,官方校验源不可达时
按[下载与完整性校验](#下载与完整性校验)的回退顺序处理。

### npm registry

```sh
sdkvm nrm use taobao   # 国内常用
sdkvm nrm use npm      # 恢复官方
sdkvm nrm test         # 测延迟
```

### Maven 依赖镜像

`sdkvm mrm` 在 `settings.xml` 里写入或删除一段标记块(`mirrorOf=*`,`id=sdkvm`)。
`use official` 只删除这段,文件里其它 mirror、server、profile 保持不变。阿里云
这里是聚合仓 `repository/public`,与安装包镜像的 `repository/central` 不是同一地址。

```sh
sdkvm mrm use aliyun    # 依赖走阿里云 public
sdkvm mrm use official  # 移除 sdkvm 这段 mirror
sdkvm mrm settings ~/work/settings.xml
mvn -s ~/work/settings.xml compile   # 非默认路径时需要自行携带 -s
```

## 安全模型

- **来源可信**:下载 URL 由官方 API 解析,不抓取搜索页,不执行镜像站返回的任何
  脚本;https 重定向不允许降级到 http。
- **传输完整**:SHA-256 在下载过程中流式计算,落地前与官方清单比对;镜像与
  安装器场景强制校验,无哈希即失败。
- **解压受控**:只解压到全新空目录;归档必须具有单一根目录与预期可执行文件;
  条目路径(含符号链接目标)不得越出解压目录(zip-slip 防护)。
- **写入最小化**:对宿主环境仅追加带标记的 rc 块或写用户级环境变量;配置与
  settings.xml 均为原子替换;不保存任何凭据(`mrm` 的仓库 URL 不允许携带
  用户名密码,`nrm` 不写入 token)。
- **进程互斥**:写操作持排他文件锁,防止并发互相覆盖。
- **执行边界**:Miniconda 安装器仅在哈希核对通过后以静默模式执行;Windows 侧
  的注册表与脚本操作通过受控参数构造,不经字符串拼接 shell。

## 故障排查

### `use` 之后命令还是旧版本

rc 块在新终端或 `source ~/.zshrc` 之后生效;IDE 需要重启。先用 `sdkvm current`
确认链接已切换。Windows 上注册表已更新,但已打开的终端读不到新值。

### 提示 `Another sdkvm operation is in progress`

确认没有其它 sdkvm 进程在运行(含中断的下载)后,按提示删除 `~/.sdkvm/.lock`。
持锁进程正常退出或心跳超过 5 分钟未刷新时,锁会被自动接管,通常无需手动处理。

### 环境变量从 `GOROOT` / `FLUTTER_ROOT` 改名

现统一为 `GO_HOME`、`FLUTTER_HOME`(与 `JAVA_HOME` / `NODE_HOME` 对齐)。升级
CLI 后请对已启用的 SDK 重新执行一次 `use`,并删除用户环境里残留的旧变量名
(Windows 注册表 / 旧 rc 手工行)。

### fish 或 nushell

自动写入只支持 zsh 与 bash。检测不到 rc 文件时,`use` 会打印可直接粘贴的
配置块——`$SHELL` 指向 fish 时自动给出 fish 语法。手动改写请参考[版本切换](#版本切换)中的块。fish 示例:

```fish
set -gx JAVA_HOME $HOME/.sdkvm/current-java
set -gx GO_HOME $HOME/.sdkvm/current-go
set -gx FLUTTER_HOME $HOME/.sdkvm/current-flutter
set -gx NODE_HOME $HOME/.sdkvm/current-node
set -gx MAVEN_HOME $HOME/.sdkvm/current-maven
fish_add_path $JAVA_HOME/bin $GO_HOME/bin $FLUTTER_HOME/bin $NODE_HOME/bin $MAVEN_HOME/bin
```

### Flutter 下载慢或中断

先 `sdkvm flutter mirror use nju`(或 `tuna`)。超时条件是 60 秒无数据,稳定
慢速不会中断。中断后直接重跑 `install`,不会留下半成品。

### 安装 Flutter beta

使用完整 prerelease,例如 `sdkvm flutter install 3.49.0-0.1.pre`。`latest` 与
`3.47` 只解析 stable。

### CLI 会被自己管理的 Node 影响吗

脚本安装用 `~/.sdkvm/runtime` 启动 CLI,`sdkvm node use` 不影响它。npm 全局
安装跟随 `PATH` 上的 `node`;切到低于 18.15 的版本时 CLI 可能无法启动,
`sdkvm node use 22` 可恢复。

### `mirror`、`nrm`、`mrm` 的区别

见[镜像与软件源](#镜像与软件源):`mirror` 管 SDK 安装包下载,`nrm` 管 npm
拉包,`mrm` 管 Maven 依赖仓库(`settings.xml`)。

### 代理

当前不读取 `HTTPS_PROXY` 等代理变量,可使用系统级透明代理。

### CI 或多用户隔离

设置 `SDKVM_HOME=/path/to/dir`。安装、链接与配置全部跟随该目录,天然支持
按项目或按用户隔离。

## 卸载

**npm 安装**:

```sh
npm uninstall -g sdkvm
```

pnpm、yarn、bun 使用各自的全局卸载命令。

**脚本安装**:先移除入口与 CLI(已安装的 SDK 不受影响):

```sh
rm -rf ~/.sdkvm/bin ~/.sdkvm/cli ~/.sdkvm/runtime
```

Windows 对应删除 `%USERPROFILE%\.sdkvm\bin\sdkvm.cmd`、`%USERPROFILE%\.sdkvm\cli`
与 `%USERPROFILE%\.sdkvm\runtime`,并从用户 PATH 移除 `%USERPROFILE%\.sdkvm\bin`。

确认不再需要已安装的各 SDK 后,删除数据目录:

```sh
rm -rf ~/.sdkvm
```

同时清理 shell 配置中的 sdkvm 内容:

- `# >>> sdkvm path >>>` … `# <<< sdkvm path <<<`
- 各 SDK 的 `# >>> sdkvm java|go|flutter|node|maven|miniconda|python init >>>` … `# <<< … <<<`

Windows 还需在系统设置中删除 `JAVA_HOME`、`GO_HOME`、`FLUTTER_HOME`、
`NODE_HOME`、`MAVEN_HOME`、`MINICONDA_HOME`、`PYTHON_HOME`,并从用户 PATH 移除
`%JAVA_HOME%\bin`、`%GO_HOME%\bin`、`%FLUTTER_HOME%\bin`、`%NODE_HOME%`、
`%MAVEN_HOME%\bin`、`%MINICONDA_HOME%`、`%MINICONDA_HOME%\Scripts`、
`%MINICONDA_HOME%\Library\bin`、`%PYTHON_HOME%`、`%PYTHON_HOME%\Scripts`。

## 参与开发

```sh
git clone https://github.com/QInJ1995/sdkvm.git && cd sdkvm
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` 使用 tsup 生成 `dist/index.js`;本地试用执行 `node dist/index.js`。
CI 在 macOS / Ubuntu / Windows 三平台运行类型检查、单元测试、构建打包与真实
安装 / 切换 / 卸载的 e2e 验证。

```
src/
├── cli/       # install / use / ls / uninstall / mirror / nrm / mrm / upgrade
├── core/      # 版本解析、注册表、配置、文件锁、平台探测
├── sdk/       # 各 SDK 的目录、环境变量、版本语法、二进制路径描述
├── vendor/    # 各发行版的列表与解析,及镜像改写
├── fs/        # 解压、目录归一化、链接
├── shell/     # rc 写入、Windows 注册表
├── net/       # fetch、流式下载、校验
└── ui/        # 日志与进度
```

新增一种语言:在 `src/vendor/` 实现 `listMajors` 与 `resolve`,在 `src/sdk/`
添加类型描述(安装目录、current 链接、环境变量、版本语法、二进制路径),并注册
到 `sdk/index.ts`——install / use / ls / uninstall / mirror 及 rc、注册表写入
随之生效。

## 许可证

[MIT](./LICENSE) © sdkvm contributors
