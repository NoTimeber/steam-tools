// 字段级加密:AES-256-GCM,每个值独立随机 IV。
// 密文格式:v1.<主密钥指纹 8 位>.<base64url(iv | authTag | ciphertext)>
// purpose 作为 AAD 参与认证(如 "account.password"),防止把一列的密文挪到另一列去解。

import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultError extends Error {
	override name = 'VaultError';
}

export interface Vault {
	readonly keyId: string;
	encrypt(plaintext: string, purpose: string): string;
	decrypt(sealed: string, purpose: string): string;
	encryptJson(value: unknown, purpose: string): string;
	decryptJson<T>(sealed: string, purpose: string): T;
}

export function keyIdOf(key: Buffer): string {
	return createHash('sha256').update('steam-tools/key-id/').update(key).digest('hex').slice(0, 8);
}

export function createVault(key: Buffer): Vault {
	if (key.length !== KEY_BYTES) {
		throw new VaultError(`主密钥必须是 ${KEY_BYTES} 字节,实际 ${key.length} 字节`);
	}
	const keyId = keyIdOf(key);
	const prefix = `${VERSION}.${keyId}.`;

	function encrypt(plaintext: string, purpose: string): string {
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		cipher.setAAD(Buffer.from(purpose, 'utf8'));
		const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
	}

	function decrypt(sealed: string, purpose: string): string {
		const parts = String(sealed).split('.');
		if (parts.length !== 3 || parts[0] !== VERSION) {
			throw new VaultError('不是有效的密文');
		}
		if (parts[1] !== keyId) {
			throw new VaultError(`密文属于另一把主密钥(指纹 ${parts[1]}),当前主密钥指纹是 ${keyId}`);
		}
		const raw = Buffer.from(parts[2] ?? '', 'base64url');
		if (raw.length < IV_BYTES + TAG_BYTES) {
			throw new VaultError('密文长度不对');
		}
		const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(purpose, 'utf8'));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		try {
			return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
		} catch {
			throw new VaultError(`密文校验失败(被篡改,或用途不是 ${purpose})`);
		}
	}

	return {
		keyId,
		encrypt,
		decrypt,
		encryptJson: (value, purpose) => encrypt(JSON.stringify(value), purpose),
		decryptJson: <T>(sealed: string, purpose: string) => JSON.parse(decrypt(sealed, purpose)) as T
	};
}

// ===== 主密钥加载 =====

export interface LoadMasterKeyOptions {
	env: Record<string, string | undefined>;
	/** 没设 MASTER_KEY_FILE 时的默认密钥文件路径 */
	defaultKeyFile: string;
	logger?: Pick<Console, 'warn'>;
}

export interface MasterKey {
	key: Buffer;
	/** 'env' | 文件路径 */
	source: string;
	generated: boolean;
}

function decodeKey(text: string, source: string): Buffer {
	const value = text.trim();
	const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
	if (key.length !== KEY_BYTES) {
		throw new VaultError(`${source} 里的主密钥解码后是 ${key.length} 字节,需要 ${KEY_BYTES} 字节(用 openssl rand -base64 32 生成)`);
	}
	return key;
}

// 优先级:MASTER_KEY 环境变量 > MASTER_KEY_FILE 指向的文件 > 默认密钥文件。
// 文件不存在时:生产环境(NODE_ENV=production)直接报错——容器里自动生成的密钥会随容器重建丢失,
// 数据就再也解不开;开发环境自动生成一把并提示。
export function loadMasterKey(options: LoadMasterKeyOptions): MasterKey {
	const {env, defaultKeyFile} = options;
	const logger = options.logger ?? console;
	if (env.MASTER_KEY && env.MASTER_KEY.trim()) {
		return {key: decodeKey(env.MASTER_KEY, 'MASTER_KEY 环境变量'), source: 'env', generated: false};
	}
	const file = env.MASTER_KEY_FILE && env.MASTER_KEY_FILE.trim() ? env.MASTER_KEY_FILE.trim() : defaultKeyFile;
	if (existsSync(file)) {
		return {key: decodeKey(readFileSync(file, 'utf8'), file), source: file, generated: false};
	}
	if (env.NODE_ENV === 'production') {
		throw new VaultError(
			`找不到主密钥文件 ${file}。生产环境不会自动生成(容器重建后会丢,数据将无法解密)。` +
			'请在宿主机执行 openssl rand -base64 32 > secrets/master.key 并挂载进容器,见 DEPLOY.md。'
		);
	}
	const key = randomBytes(KEY_BYTES);
	mkdirSync(dirname(file), {recursive: true});
	writeFileSync(file, key.toString('base64') + '\n', {encoding: 'utf8', mode: 0o600, flag: 'wx'});
	try {
		chmodSync(file, 0o600);
	} catch {
		// Windows 上 chmod 只影响只读位,忽略
	}
	logger.warn(`[vault] 未找到主密钥,已生成新密钥 ${file}。请备份它:丢了这个文件,数据库里的密码/令牌都无法解密。`);
	return {key, source: file, generated: true};
}
