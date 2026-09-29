import { loadConfig, updateConfig } from '../core/config.js';
import { log } from '../ui/log.js';
import { SdkvmError } from '../util/errors.js';
import { allVendorIds } from '../vendor/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { cmdPath } from './cmdname.js';
import {
  availableSiteNamesForType,
  findMirrorSite,
  formatMirrorListLine,
  listMirrorSitesForType,
  matchMirrorSiteName,
  mirrorableVendors,
  parseMirrorRootUrl,
  siteVendorsForType,
  type MirrorVendorId,
} from './mirror-presets.js';

function mirrorableIds(type: SdkTypeId): MirrorVendorId[] {
  return [...mirrorableVendors(type)];
}

function firstMirrorable(type: SdkTypeId): MirrorVendorId | '' {
  return mirrorableVendors(type)[0] ?? '';
}

export function mirrorCommand(
  type: SdkTypeId,
  action: string | undefined,
  arg1: string | undefined,
  arg2: string | undefined,
): void {
  const mirrorable = mirrorableIds(type);
  const first = firstMirrorable(type);
  const prefix = cmdPath(type);

  if (action === 'ls' || action === 'list') {
    const config = loadConfig();
    const matched = matchMirrorSiteName(type, config.mirror);
    for (const site of listMirrorSitesForType(type)) {
      let detail: string;
      if (site.name === 'official') {
        detail = '(official source)';
      } else {
        const scoped = siteVendorsForType(site, type);
        detail = Object.entries(scoped)
          .map(([id, url]) => (mirrorable.length === 1 ? url! : `${id}=${url}`))
          .join(' ');
      }
      log.raw(formatMirrorListLine(site.name, detail, matched === site.name));
    }
    if (matched == null) {
      const parts = mirrorable.map((id) => {
        const url = config.mirror[id];
        return url ? `${id}=${url}` : `${id}=(official)`;
      });
      log.raw(formatMirrorListLine('custom', parts.join(' '), true));
    }
    return;
  }

  if (action === 'use') {
    const name = arg1;
    if (!name) {
      throw new SdkvmError(`usage: ${prefix} mirror use <site>`, {
        hint: `Available: ${availableSiteNamesForType(type).join(', ')}`,
      });
    }
    const site = findMirrorSite(name);
    if (!site || (site.name !== 'official' && Object.keys(siteVendorsForType(site, type)).length === 0)) {
      throw new SdkvmError(`Unknown or unsupported mirror site "${name}" for ${type}`, {
        hint: `Available: ${availableSiteNamesForType(type).join(', ')}`,
      });
    }

    if (site.name === 'official') {
      updateConfig((config) => {
        for (const id of mirrorable) {
          delete config.mirror[id];
        }
      });
      log.ok(`mirror for ${type} → official`);
      return;
    }

    const scoped = siteVendorsForType(site, type);
    const changed: string[] = [];
    updateConfig((config) => {
      for (const [id, url] of Object.entries(scoped) as [MirrorVendorId, string][]) {
        config.mirror[id] = url;
        changed.push(`${id} → ${url}`);
      }
    });
    log.ok(`mirror site ${site.name}: ${changed.join('; ')}`);
    return;
  }

  if (action === 'current') {
    const config = loadConfig();
    const matched = matchMirrorSiteName(type, config.mirror);
    if (matched === 'official') {
      log.raw(`official → (no mirror)`);
      for (const id of allVendorIds(type)) {
        log.raw(`  ${id.padEnd(8)} (official)`);
      }
      return;
    }
    if (matched) {
      const site = findMirrorSite(matched)!;
      const scoped = siteVendorsForType(site, type);
      const firstUrl = Object.values(scoped)[0] ?? '';
      log.raw(`${matched} → ${firstUrl}`);
    } else {
      log.raw('custom →');
    }
    for (const id of allVendorIds(type)) {
      const url = config.mirror[id];
      log.raw(`  ${id.padEnd(8)} ${url ?? '(official)'}`);
    }
    return;
  }

  // <cmd> mirror set [vendor] <url> / unset [vendor] / show
  if (action === 'set') {
    let vendor: string;
    let url: string | undefined;
    if (arg2 !== undefined) {
      vendor = arg1 ?? '';
      url = arg2;
    } else {
      vendor = first;
      url = arg1;
    }
    if (!url) throw new SdkvmError(`usage: ${prefix} mirror set [vendor] <url>`);
    const siteHit = findMirrorSite(url);
    if (!url.includes('://') && siteHit) {
      throw new SdkvmError(`"${url}" is a mirror site name, not a URL`, {
        hint: `Use: ${prefix} mirror use ${siteHit.name}`,
      });
    }
    if (!mirrorable.includes(vendor as MirrorVendorId)) {
      const preset = availableSiteNamesForType(type).find((n) => n !== 'official');
      throw new SdkvmError(`mirroring is only supported for ${mirrorable.join(', ') || 'none'} (got "${vendor}")`, {
        hint: preset
          ? `recommended: ${prefix} mirror use ${preset}  (or set URL: ${prefix} mirror set ${first} <url>)`
          : undefined,
      });
    }
    let normalized: string;
    try {
      normalized = parseMirrorRootUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SdkvmError(msg, {
        hint: msg.includes('protocol') ? 'Expected http:// or https://' : undefined,
      });
    }
    updateConfig((config) => {
      config.mirror[vendor] = normalized;
    });
    log.ok(`mirror for ${vendor} → ${normalized}`);
    return;
  }

  if (action === 'unset') {
    const vendor = arg1 ?? first;
    if (vendor && findMirrorSite(vendor)?.name === 'official') {
      throw new SdkvmError(`To clear mirrors, use: ${prefix} mirror use official`, {
        hint: `Or: ${prefix} mirror unset ${first || '<vendor>'}`,
      });
    }
    if (!mirrorable.includes(vendor as MirrorVendorId)) {
      throw new SdkvmError(`mirroring is only supported for ${mirrorable.join(', ') || 'none'}`);
    }
    updateConfig((config) => {
      delete config.mirror[vendor];
    });
    log.ok(`mirror for ${vendor} cleared (official source)`);
    return;
  }

  // show / 无参数
  if (action !== undefined && action !== 'show') {
    throw new SdkvmError(`unknown mirror action "${action}"`, {
      hint: `usage: ${prefix} mirror ls|use|current|show|set|unset`,
    });
  }

  const config = loadConfig();
  const matched = matchMirrorSiteName(type, config.mirror);
  log.raw(`mirrors${matched ? ` (${matched})` : ''}:`);
  for (const id of allVendorIds(type)) {
    const url = config.mirror[id];
    log.raw(`  ${id.padEnd(8)} ${url ?? '(official)'}`);
  }
  if (first) {
    const preset = availableSiteNamesForType(type).find((n) => n !== 'official');
    log.raw(`list sites: ${prefix} mirror ls`);
    // 提示的站点必须真的覆盖本类型（maven 只有 aliyun/huawei，cpython 无预设）
    if (preset) log.raw(`use a site: ${prefix} mirror use ${preset}`);
  }
}
