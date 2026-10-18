/**
 * lib/errors.mjs — 非配置类失败（退出码 1 的那一族）
 *
 * 单独一个文件是为了打断循环依赖：`commands.mjs` ←→ `install.mjs` 互相要用它，
 * 而 `io.mjs`（参数读取）也要用它。放在这里，谁都能 import 而不成环。
 *
 * 退出码约定（与 bin/feishu-notify-cli、lib/config.mjs 的 ConfigError 一致）：
 *   0 成功 ／ 1 用法或运行期失败 ／ 2 配置问题（ConfigError，见 lib/config.mjs）
 */

export class CommandError extends Error {
	constructor(message, { exitCode = 1, reason = "command" } = {}) {
		super(message);
		this.name = "CommandError";
		this.exitCode = exitCode;
		this.reason = reason;
	}
}
