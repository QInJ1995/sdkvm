import { describe, expect, it } from 'vitest';
import { JAVA_VENDOR_IDS } from '../src/core/version.js';
import { allVendorIds, JAVA_VENDORS } from '../src/vendor/index.js';
import { MIRRORABLE_BY_TYPE } from '../src/cli/mirror-presets.js';
import { MIRROR_REWRITE_VENDORS } from '../src/vendor/mirror.js';
import type { SdkTypeId } from '../src/sdk/types.js';

/** 双处维护的 vendor 表必须保持一致：改一处不改另一处时这里会红 */
describe('vendor 表一致性', () => {
  it('JAVA_VENDOR_IDS 与 JAVA_VENDORS 注册一致', () => {
    expect([...JAVA_VENDOR_IDS]).toEqual(JAVA_VENDORS.map((v) => v.id));
  });

  it('MIRRORABLE_BY_TYPE 恰好按类型划分 MIRROR_REWRITE_VENDORS', () => {
    const flat = Object.values(MIRRORABLE_BY_TYPE).flat();
    expect(flat.length).toBe(new Set(flat).size); // 无重复
    expect(new Set(flat)).toEqual(MIRROR_REWRITE_VENDORS); // 无遗漏
    for (const [type, ids] of Object.entries(MIRRORABLE_BY_TYPE) as [SdkTypeId, string[]][]) {
      const known = allVendorIds(type);
      for (const id of ids) expect(known).toContain(id); // 不引入该类型不存在的 vendor
    }
  });
});
