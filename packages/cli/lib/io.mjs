/**
 * lib/io.mjs — 命令行 I/O 与参数读取的最小公共件
 *
 * 从 `commands.mjs` 抽出来，供 `install.mjs`（Step 4）复用：
 * 两个模块都要"把结果写 stdout、把提示写 stderr、从 argv 里取 flag 的值"，
 * 各写一份就会漂移（比如一边允许 `--flag=x`、另一边不允许）。
 *
 * 只放**纯输出与纯解析**；任何业务判断仍留在各自模块里。
 */

import { CommandError } from "./errors.mjs";

/** 统一注入点：测试传内存流，生产用 process.* */
export function makeIo(io = {}) {
	return {
		stdout: io.stdout ?? process.stdout,
		stderr: io.stderr ?? process.stderr,
		stdin: io.stdin ?? process.stdin,
	};
}

export function say(io, text = "") {
	io.stdout.write(`${text}\n`);
}

export function warn(io, text) {
	io.stderr.write(`${text}\n`);
}

/** 取一个 flag 的值；缺值或下一个是 flag 都算用法错误 */
export function takeValue(argv, index, flag) {
	const value = argv[index];
	if (value === undefined || (value.startsWith("--") && value !== "-")) {
		throw new CommandError(`${flag} 需要一个值`, { reason: "usage" });
	}
	return value;
}
