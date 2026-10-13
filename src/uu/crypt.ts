// 悠悠有品 uk 握手用的加密(从 app/lib/uu-crypt.js 移来,移植自 Steamauto 的 uuyoupinapi/UUApiCrypt.py)。
// 业务数据用 AES-128-ECB(PKCS7)加密;随机 AES 密钥用固定 RSA 公钥(PKCS1 v1.5)加密。

import {constants, createCipheriv, createDecipheriv, publicEncrypt} from 'node:crypto';

// 与 Python 版一致的固定公钥(64 字符换行,兼容 OpenSSL 解析)
export const UU_PUBLIC_KEY_PEM = [
	'-----BEGIN PUBLIC KEY-----',
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv9BDdhCDahZNFuJeesx3',
	'gzoQfD7pE0AeWiNBZlc21ph6kU9zd58X/1warV3C1VIX0vMAmhOcj5u86i+L2Lb',
	'2V68dX2Nb70MIDeW6Ibe8d0nF8D30tPsM7kaAyvxkY6ECM6RHGNhV4RrzkHmf5D',
	'eR9bybQGE0A9jcjuxszD1wsW/n19eeom7MroHqlRorp5LLNR8bSbmhTw6M/RQ/F',
	'm3lKjKcvs1QNVyBNimrbD+ZVPE/KHSZLQ1jdF6tppvFnGxgJU9NFmxGFU0hx6cZ',
	'iQHkhOQfGDFkElxgtj8gFJ1narTwYbvfe5nGSiznv/EUJSjTHxzX1TEkex0+5j4',
	'vSANt1QIDAQAB',
	'-----END PUBLIC KEY-----'
].join('\n');

export class UuApiCrypt {
	private readonly aesKey: Buffer;

	/** aesKey:16 个字符(generateRandomString(16))→ 16 字节 → AES-128 */
	constructor(aesKey: string) {
		this.aesKey = Buffer.from(String(aesKey), 'utf8');
		if (this.aesKey.length !== 16) {
			throw new Error('UU AES key 必须为 16 字节，当前为 ' + this.aesKey.length);
		}
	}

	/** 用固定 RSA 公钥加密 AES 密钥,返回 base64 */
	getEncryptedAesKey(): string {
		return publicEncrypt({key: UU_PUBLIC_KEY_PEM, padding: constants.RSA_PKCS1_PADDING}, this.aesKey).toString('base64');
	}

	/** AES-128-ECB + PKCS7 加密,返回 base64 */
	encrypt(content: string): string {
		const cipher = createCipheriv('aes-128-ecb', this.aesKey, null);
		cipher.setAutoPadding(true);
		return Buffer.concat([cipher.update(String(content), 'utf8'), cipher.final()]).toString('base64');
	}

	decrypt(encryptedBase64: string): string {
		const decipher = createDecipheriv('aes-128-ecb', this.aesKey, null);
		decipher.setAutoPadding(true);
		return Buffer.concat([decipher.update(Buffer.from(String(encryptedBase64), 'base64')), decipher.final()]).toString('utf8');
	}
}
