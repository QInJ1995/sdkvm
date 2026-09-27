import type { Platform } from '../core/platform.js';
import type { ReleaseLine, SdkVersion, UserSpec, Vendor, VendorPlatform, VersionSpec } from '../vendor/types.js';

/** SDK 类型 id：java / go / flutter / node / maven / miniconda / python（未来可扩展） */
export type SdkTypeId = 'java' | 'go' | 'flutter' | 'node' | 'maven' | 'miniconda' | 'python';

/**
 * SDK 类型描述：目录布局、版本语法、环境变量、探测方式全部按类型参数化，
 * cli/core 各层经它泛化，新增 SDK 类型不再复制命令实现。
 */
export interface SdkTypeSpec {
  readonly id: SdkTypeId;
  /** 展示名，如 "Java (JDK)" */
  readonly label: string;
  /** 安装根目录名（根目录之下），java 沿用历史名 jdks */
  readonly installDirName: string;
  /** current 链接名（根目录之下） */
  readonly currentLinkName: string;
  /** 切换时导出的环境变量名：JAVA_HOME / GO_HOME / FLUTTER_HOME / NODE_HOME / MAVEN_HOME / MINICONDA_HOME / PYTHON_HOME */
  readonly envVar: string;
  /** 是否支持 lts 语义（java / node 有，go / flutter / maven / miniconda / python 没有） */
  readonly supportsLts: boolean;
  /** use 之后若进程里没有 JAVA_HOME，提示先切换 JDK（Maven 需要） */
  readonly requiresJdk?: boolean;
  /**
   * 已安装版本里哪些 major 算 LTS（仅 supportsLts 时使用）。
   * java 对齐 Adoptium；node 为偶数年 major（官方 LTS 线约定）。
   */
  isLtsMajor?(major: number): boolean;
  /** 有序厂商列表，[0] 为默认厂商 */
  readonly vendors: readonly Vendor[];
  parseUserSpec(input: string): UserSpec;
  /**
   * full 规格是否命中已安装版本。
   * 缺省为格式化串相等，或以 + / . 续段（java 的 21.0.5 命中 21.0.5+11）。
   * Miniconda 的 py313、26.7.1-1 不是格式化串前缀，要按 Python 和构建号比。
   */
  matchesFull?(installed: SdkVersion, version: string): boolean;
  /**
   * major / line / latest 是否纳入该已安装版本。缺省全部纳入。
   * Python 预发布不纳入，只能用完整版本号切换。
   */
  matchesLoose?(installed: SdkVersion): boolean;
  /** 安装目录名 → 版本；不匹配返回 null */
  parseDirName(dir: string): SdkVersion | null;
  formatVersion(v: SdkVersion): string;
  compareVersions(a: SdkVersion, b: SdkVersion): number;
  /** home 目录内可执行文件的相对路径 */
  binRelPath(platform: Platform | VendorPlatform): string;
  /** 环境变量目录追加到 PATH 的段（rc 守卫与 Windows PATH entry 共用；node 在 windows 无 bin/ → ''） */
  envBinSuffix(platform: Platform | VendorPlatform): string;
  /**
   * Windows 用户 PATH 要追加的后缀。缺省为 [envBinSuffix]。
   * Miniconda 需要根目录（python.exe）、Scripts（conda.exe）和 Library\bin。
   */
  envPathSuffixes?(platform: Platform | VendorPlatform): readonly string[];
  /**
   * 写在 PATH 行之后、标记块之内的额外 shell 片段。
   * Miniconda 用来 source conda.sh，使 `conda activate` 可用。返回值按原样写入 rc。
   */
  rcExtra?(envVar: string): string;
  /** 解压根目录 → 环境语义目录（java macOS bundle → Contents/Home；go 原样） */
  locateHome(root: string): string;
  /** use 后打印版本的方式（java -version 在 stderr；go version 在 stdout） */
  readonly versionCheck: { args: string[]; stream: 'stdout' | 'stderr' };
}

export type { ReleaseLine, SdkVersion, UserSpec, VersionSpec, Vendor };
