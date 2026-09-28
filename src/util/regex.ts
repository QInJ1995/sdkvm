/** 正则字面量转义（rc 标记块、mrm settings.xml 等动态拼 pattern 共用） */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
