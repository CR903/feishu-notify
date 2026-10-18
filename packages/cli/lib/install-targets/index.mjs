/**
 * lib/install-targets/index.mjs — 三个安装目标的注册表（顺序 = 打印与执行顺序）
 *
 * 顺序按"用户跑 install 的动机强弱"排：
 *   Claude Code（hook 两行就接完，最常用）→ opencode（要等插件包）→ DSH（要等适配器包）
 */

import * as claudeCode from "./claude-code.mjs";
import * as dsh from "./dsh.mjs";
import * as opencode from "./opencode.mjs";

export const TARGETS = [claudeCode, opencode, dsh];

/** 名字或别名 → 目标模块；认不出返回 undefined */
export function findTargetByName(name) {
	const wanted = String(name ?? "").trim().toLowerCase();
	if (wanted === "") return undefined;
	return TARGETS.find((target) => target.id === wanted || (target.aliases ?? []).includes(wanted));
}

export function targetNames() {
	return TARGETS.map((target) => target.id);
}

export function targetLabelList() {
	return TARGETS.map((target) => `${target.id}（${target.label}）`).join(" · ");
}
