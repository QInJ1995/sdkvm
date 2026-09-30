/** 统一错误类型：携带退出码与可选修复提示，由入口统一捕获输出 */
export class SdkvmError extends Error {
  readonly exitCode: number;
  readonly hint?: string;
  /** 底层原始错误。如 execFile 失败：errno 字符串 code = 启动失败，数字 code = 非零退出 */
  readonly cause?: unknown;

  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'SdkvmError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }
}

export function toSdkvmError(err: unknown): SdkvmError {
  if (err instanceof SdkvmError) return err;
  if (err instanceof Error) return new SdkvmError(err.message);
  return new SdkvmError(String(err));
}
