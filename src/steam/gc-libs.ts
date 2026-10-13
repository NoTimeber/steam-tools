// 加载 CS2(globaloffensive)和 TF2(tf2)的 GC 库,并修好它们共用的 protobufjs 根。
//
// tf2 与 globaloffensive 都往 protobufjs 的共享根(roots["default"])写 CMsgClientWelcome,但 tf2 的版本没有嵌套的
// Location 类型。tf2 后加载会用「无 Location」的版本覆盖共享根,连接 CS2 GC 收到欢迎消息时解码引用
// $root.CMsgClientWelcome.Location 为 undefined,整个进程崩溃。这里在两个库都加载之后把 globaloffensive
// 带 Location 的版本装回共享根;tf2 自己的欢迎消息没有 location 字段,解码不引用该嵌套类型,不受影响。
// (已知未修:同样的覆盖让 CS2 的 StoreGetUserData 请求丢了 currency 字段,要真实账号才能验证。)

import {createRequire} from 'node:module';
import type {GcModuleOptions} from './gc-modules.ts';

const require = createRequire(import.meta.url);

export const GlobalOffensive = require('globaloffensive') as GcModuleOptions['GlobalOffensive'];
export const TeamFortress2 = require('tf2') as GcModuleOptions['TeamFortress2'];

try {
	const pbRoot = (require('protobufjs/minimal') as {roots: Record<string, any>}).roots['default'];
	const goWelcome = (require('globaloffensive/protobufs/generated/_load') as Record<string, any>).CMsgClientWelcome;
	if (pbRoot && goWelcome && goWelcome.Location
		&& (!pbRoot.CMsgClientWelcome || !pbRoot.CMsgClientWelcome.Location)) {
		pbRoot.CMsgClientWelcome = goWelcome;
	}
} catch (err) {
	console.error('[protobuf-fix] 修复 CMsgClientWelcome 共享根冲突失败:', err && (err as Error).message ? (err as Error).message : err);
}
