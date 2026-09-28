/** nrm / mrm / mirror 共用的列表行与 registry URL 工具 */
export const LIST_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 比较用规范化：去空白、去尾斜杠、小写 */
export function normalizeRegistryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** `* name ----------- detail` 形式的列表行 */
export function formatListLine(name: string, detail: string, current: boolean): string {
  const mark = current ? '*' : ' ';
  const padded = `${name} `.padEnd(14, '-');
  return `${mark} ${padded} ${detail}`;
}
