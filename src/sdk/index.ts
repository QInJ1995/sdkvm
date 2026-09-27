import type { SdkTypeId, SdkTypeSpec } from './types.js';
import { javaSdk } from './java.js';
import { goSdk } from './go.js';
import { flutterSdk } from './flutter.js';
import { nodeSdk } from './node.js';
import { mavenSdk } from './maven.js';
import { minicondaSdk } from './miniconda.js';
import { SdkvmError } from '../util/errors.js';

const SPECS: Partial<Record<SdkTypeId, SdkTypeSpec>> = {
  java: javaSdk,
  go: goSdk,
  flutter: flutterSdk,
  node: nodeSdk,
  maven: mavenSdk,
  miniconda: minicondaSdk,
};

/** 已注册的 SDK 类型（current/迁移等需要遍历全部类型时使用） */
export const SDK_TYPES: readonly SdkTypeId[] = ['java', 'go', 'flutter', 'node', 'maven', 'miniconda'];

export function getSdkType(id: SdkTypeId): SdkTypeSpec {
  const spec = SPECS[id];
  if (!spec) throw new SdkvmError(`Unknown SDK type: ${id}`);
  return spec;
}
