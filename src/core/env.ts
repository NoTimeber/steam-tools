// 入口第一个 import:定位安装根并加载它下面的 .env(Node>=20.6 内置)。
// 必须先于其它模块执行,因为有的模块在加载时就读环境变量(如 src/steam/community.ts 的 STEAM_WEB_USER_AGENT)。
//
// 安装根(install root)存放 data/、.env、secrets/、node_modules,不随代码更新动;
// 旧版 launcher 启动时注入 APP_ROOT,Docker 里也设了;没设时就是仓库根(src/ 的上一级)。

import {join, resolve} from 'node:path';

export const APP_ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : join(import.meta.dirname, '..', '..');
/** 随代码发布的目录:旧版前端、物品 schema、随包皮肤库、社区 nameid 库 */
export const APP_DIR = join(import.meta.dirname, '..', '..', 'app');
/** 新版前端(web/)的构建产物 */
export const WEB_DIST_DIR = join(import.meta.dirname, '..', '..', 'web', 'dist');

try {
	process.loadEnvFile(join(APP_ROOT, '.env'));
} catch {
	// 没有 .env 文件时静默跳过,继续用系统环境变量
}
