import type { SdkTypeId } from '../sdk/types.js';
import {
  FLUTTER_VENDOR_IDS,
  GO_VENDOR_IDS,
  JAVA_VENDOR_IDS,
  MAVEN_VENDOR_IDS,
  MINICONDA_VENDOR_IDS,
  NODE_VENDOR_IDS,
  PYTHON_VENDOR_IDS,
} from '../core/version.js';
import { MIRROR_REWRITE_VENDORS } from '../vendor/mirror.js';
import { formatListLine } from '../ui/listformat.js';

/** 支持镜像的 vendor id（与 applyMirror / 历史 RECOMMENDED 对齐） */
export type MirrorVendorId = 'temurin' | 'golang' | 'flutter' | 'nodejs' | 'maven' | 'miniconda' | 'cpython';

export interface MirrorSite {
  name: string;
  aliases?: readonly string[];
  /** 是否在 ls 中展示（别名站可隐藏） */
  list: boolean;
  /** 该站对各 vendor 的镜像根；缺省表示本站不覆盖该 vendor */
  vendors: Partial<Record<MirrorVendorId, string>>;
}

/** 各类型 vendor 全集里支持镜像改写的子集（真相在 MIRROR_REWRITE_VENDORS） */
function mirrorableOf(vendorIds: readonly string[]): MirrorVendorId[] {
  return vendorIds.filter((id): id is MirrorVendorId => MIRROR_REWRITE_VENDORS.has(id));
}

/** SDK 类型 → 可镜像的 vendor（本版每类型至多一个） */
export const MIRRORABLE_BY_TYPE: Record<SdkTypeId, readonly MirrorVendorId[]> = {
  java: mirrorableOf(JAVA_VENDOR_IDS),
  go: mirrorableOf(GO_VENDOR_IDS),
  flutter: mirrorableOf(FLUTTER_VENDOR_IDS),
  node: mirrorableOf(NODE_VENDOR_IDS),
  maven: mirrorableOf(MAVEN_VENDOR_IDS),
  miniconda: mirrorableOf(MINICONDA_VENDOR_IDS),
  python: mirrorableOf(PYTHON_VENDOR_IDS),
};

/**
 * 内置镜像站。只收录与 applyMirror 路径约定兼容、且站方/文档可对上的根 URL。
 * tuna 不含 nodejs：TUNA nodejs-release 归档不全。
 * tuna 不含 flutter：TUNA 的 /flutter 目录已下线（404），flutter 镜像用 nju。
 * nju / tuna 不含 maven：它们的 Apache 发行目录不是 Maven Central 路径。
 * miniconda 只收录安装器目录（Miniconda3-*.sh / .exe），不是 pkgs/ 频道。
 * aliyun 的 /anaconda/miniconda 返回 404，不收录。
 * cpython 的镜像根必须接 /{tag}/{filename}。国内站没有核对过这条路径，不写预设；用 mirror set 手填。
 */
export const MIRROR_SITE_PRESETS: readonly MirrorSite[] = [
  {
    name: 'nju',
    list: true,
    vendors: {
      temurin: 'https://mirrors.nju.edu.cn/adoptium',
      golang: 'https://mirror.nju.edu.cn/golang',
      flutter: 'https://mirror.nju.edu.cn/flutter/flutter_infra_release',
      nodejs: 'https://mirror.nju.edu.cn/nodejs-release',
      miniconda: 'https://mirror.nju.edu.cn/anaconda/miniconda',
    },
  },
  {
    name: 'tuna',
    aliases: ['tsinghua'],
    list: true,
    vendors: {
      temurin: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium',
      miniconda: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda',
    },
  },
  {
    name: 'aliyun',
    aliases: ['ali'],
    list: true,
    vendors: {
      golang: 'https://mirrors.aliyun.com/golang',
      nodejs: 'https://mirrors.aliyun.com/nodejs-release',
      maven: 'https://maven.aliyun.com/repository/central',
    },
  },
  {
    name: 'huawei',
    list: true,
    vendors: {
      nodejs: 'https://repo.huaweicloud.com/nodejs',
      maven: 'https://repo.huaweicloud.com/repository/maven',
    },
  },
  {
    name: 'ustc',
    list: true,
    vendors: {
      miniconda: 'https://mirrors.ustc.edu.cn/anaconda/miniconda',
    },
  },
  {
    name: 'official',
    list: true,
    vendors: {},
  },
];

/**
 * 比较用规范化：去空白与尾斜杠；只把 scheme/host 小写，保留 path 大小写
 *（TUNA 为 /Adoptium，NJU 为 /adoptium，不可整段 toLowerCase）。
 */
export function normalizeMirrorUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    const path = `${u.pathname}${u.search}${u.hash}`.replace(/\/+$/, '') || '';
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
  } catch {
    return trimmed;
  }
}

/** 校验并规范化用户输入的镜像根（写入 config）。返回解析后的 href：
 *  空白/大小写差异不再原样进库，query 与 fragment 直接拒绝——
 *  vendor 拼路径时它们只会造出取不到文件的 URL。 */
export function parseMirrorRootUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('mirror URL cannot include a username or password');
  }
  // 结尾裸 `?`/`#` 的 URL 对象 search/hash 为空串，判空拦不住，但 href 原样保留——
  // 拼下载地址时会把 `?` 带进去。在原文上拦
  if (/[?#]/.test(trimmed)) {
    throw new Error('mirror URL cannot include a query string or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/+$/, '');
}

export function mirrorableVendors(type: SdkTypeId): readonly MirrorVendorId[] {
  return MIRRORABLE_BY_TYPE[type];
}

/** 站点对本类型实际可写的 vendor → URL（official 返回空对象） */
export function siteVendorsForType(
  site: MirrorSite,
  type: SdkTypeId,
): Partial<Record<MirrorVendorId, string>> {
  const out: Partial<Record<MirrorVendorId, string>> = {};
  for (const id of mirrorableVendors(type)) {
    const url = site.vendors[id];
    if (url) out[id] = url.replace(/\/+$/, '');
  }
  return out;
}

export function findMirrorSite(name: string): MirrorSite | undefined {
  const key = name.trim().toLowerCase();
  return MIRROR_SITE_PRESETS.find(
    (s) =>
      s.name.toLowerCase() === key ||
      s.aliases?.some((a) => a.toLowerCase() === key),
  );
}

/** 对本类型至少覆盖一个 vendor 的可展示站点（含 official） */
export function listMirrorSitesForType(type: SdkTypeId): MirrorSite[] {
  return MIRROR_SITE_PRESETS.filter((s) => {
    if (!s.list) return false;
    if (s.name === 'official') return true;
    return Object.keys(siteVendorsForType(s, type)).length > 0;
  });
}

/**
 * 当前配置在本类型下命中的站点名。
 * official：本类型全部 mirrorable vendor 均未配置。
 * 其它站：该站为本类型提供的每个 URL 均与 config 一致。
 */
export function matchMirrorSiteName(
  type: SdkTypeId,
  mirror: Partial<Record<string, string | null>>,
): string | null {
  const vendors = mirrorableVendors(type);
  const allOfficial = vendors.every((id) => {
    const v = mirror[id];
    return v == null || v === '';
  });
  if (allOfficial) return 'official';

  for (const site of MIRROR_SITE_PRESETS) {
    if (site.name === 'official' || !site.list) continue;
    const scoped = siteVendorsForType(site, type);
    const ids = Object.keys(scoped) as MirrorVendorId[];
    if (ids.length === 0) continue;
    const hit = ids.every((id) => {
      const configured = mirror[id];
      if (configured == null || configured === '') return false;
      return normalizeMirrorUrl(configured) === normalizeMirrorUrl(scoped[id]!);
    });
    if (hit) return site.name;
  }
  return null;
}

export function formatMirrorListLine(name: string, detail: string, current: boolean): string {
  return formatListLine(name, detail, current);
}

export function availableSiteNamesForType(type: SdkTypeId): string[] {
  return listMirrorSitesForType(type).map((s) => s.name);
}
