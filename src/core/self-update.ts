// 面板「立即更新」:容器自己换不了镜像,更新在宿主机上做(deploy/update.sh,systemd 触发,见 deploy/install-updater.sh)。
// 这里只做两件事:
//   - 请求:在 <数据目录>/update/request.json 放一个文件(宿主机的 steam-tools-updater.path 看到就跑更新,跑之前删掉它);
//   - 进度:读 <UPDATER_DIR>/status.json(宿主机脚本写)和 installed.json(装了更新器才有)。
//     宿主机上这个目录归 root,只读挂进容器(docker-compose.yml 的 ./updater:/updater:ro),容器改不了,宿主机脚本也不读容器写的内容。
// 更新时容器会被重建:请求之后这个进程会退出,新容器起来后接着读进度,宿主机脚本等新容器健康了才写「完成」。

import {existsSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {writeFileAtomic} from './atomic-file.ts';

/** idle 没有更新;pending 请求放了、宿主机还没接手;running 更新中;done 上次更新完成;failed 上次更新失败 */
export type SelfUpdateState = 'idle' | 'pending' | 'running' | 'done' | 'failed';
/** 更新到了哪一步:git 拉代码、pull 拉镜像、up 重启服务 */
export type SelfUpdateStep = '' | 'git' | 'pull' | 'up';

export interface SelfUpdateStatus {
	/** 宿主机装了更新器(没装时面板只提示命令) */
	installed: boolean;
	state: SelfUpdateState;
	step: SelfUpdateStep;
	/** 给人看的一句话 */
	message: string;
	/** 失败那一步最后几十行输出 */
	log: string;
	/** 毫秒时间戳,没有为 0 */
	requestedAt: number;
	startedAt: number;
	finishedAt: number;
	updatedAt: number;
	/** 更新前后的版本(宿主机 package.json 里的) */
	from: string;
	to: string;
	/** 请求放了很久没人接手(更新器没在跑),或者「更新中」很久没动静 */
	stale: boolean;
}

export interface SelfUpdateOptions {
	dataDir: string;
	/** 宿主机更新器的进度目录(容器里只读) */
	updaterDir: string;
	now?: () => number;
	log?: (message: string) => void;
}

/** 请求放了这么久宿主机还没接手,就提示更新器可能没在跑 */
const PENDING_STALE_MS = 90 * 1000;
/** 「更新中」这么久没动静(宿主机脚本最多跑 30 分钟) */
const RUNNING_STALE_MS = 35 * 60 * 1000;
const STEPS: readonly SelfUpdateStep[] = ['', 'git', 'pull', 'up'];
const TEXT_MAX = 8000;

function updateError(statusCode: number, message: string): Error & {statusCode: number} {
	return Object.assign(new Error(message), {statusCode});
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const time = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));
const text = (value: unknown) => String(value ?? '').slice(0, TEXT_MAX);

export function createSelfUpdate(options: SelfUpdateOptions) {
	const now = options.now ?? Date.now;
	const requestFile = join(options.dataDir, 'update', 'request.json');
	const statusFile = join(options.updaterDir, 'status.json');
	const installedFile = join(options.updaterDir, 'installed.json');

	/** 请求的时间:文件里写的,读不出来用修改时间;没有请求为 0 */
	function requestedAt(): number {
		if (!existsSync(requestFile)) {
			return 0;
		}
		const at = time(readJson(requestFile)?.requestedAt);
		if (at) {
			return at;
		}
		try {
			return Math.floor(statSync(requestFile).mtimeMs);
		} catch {
			return 0;
		}
	}

	function status(): SelfUpdateStatus {
		const installed = !!readJson(installedFile);
		const requested = requestedAt();
		const raw = readJson(statusFile);
		const base: SelfUpdateStatus = {
			installed, state: 'idle', step: '', message: '', log: '', requestedAt: requested, startedAt: 0, finishedAt: 0, updatedAt: 0, from: '', to: '', stale: false
		};
		const state = String(raw?.state ?? '');
		const known = raw && (state === 'running' || state === 'done' || state === 'failed');
		const reported: SelfUpdateStatus | null = known
			? {
				...base,
				state: state as SelfUpdateState,
				step: STEPS.includes(raw.step as SelfUpdateStep) ? (raw.step as SelfUpdateStep) : '',
				message: text(raw.message),
				log: text(raw.log),
				startedAt: time(raw.startedAt),
				finishedAt: time(raw.finishedAt),
				updatedAt: time(raw.updatedAt),
				from: text(raw.from).slice(0, 32),
				to: text(raw.to).slice(0, 32)
			}
			: null;
		// 请求还在、宿主机的进度是这次请求之前的:还没接手(容器和宿主机是同一个系统时钟,脚本总在请求之后开始)
		if (requested && (!reported || reported.startedAt <= requested)) {
			return {...base, state: 'pending', message: '等服务器上的更新器接手', stale: now() - requested > PENDING_STALE_MS};
		}
		if (!reported) {
			return base;
		}
		if (reported.state === 'running' && now() - Math.max(reported.updatedAt, reported.startedAt) > RUNNING_STALE_MS) {
			return {...reported, stale: true};
		}
		return reported;
	}

	/** 请求更新:没装更新器、已经在更新的不让;返回最新进度 */
	function request(): SelfUpdateStatus {
		const current = status();
		if (!current.installed) {
			throw updateError(409, '服务器上还没装更新器:在部署目录执行一次 sudo ./deploy/install-updater.sh');
		}
		if ((current.state === 'pending' || current.state === 'running') && !current.stale) {
			throw updateError(409, '已经在更新了');
		}
		writeFileAtomic(requestFile, JSON.stringify({requestedAt: now()}) + '\n');
		options.log?.('[update] 面板请求更新,等服务器上的更新器接手');
		return status();
	}

	return {status, request};
}

export type SelfUpdate = ReturnType<typeof createSelfUpdate>;
