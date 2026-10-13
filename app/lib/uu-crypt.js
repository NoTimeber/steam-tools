'use strict';

// 悠悠有品 UK 加密。移植自 Steamauto 的 uuyoupinapi/UUApiCrypt.py。
// 算法：AES-128-ECB(PKCS7) 加密业务数据；RSA(PKCS1 v1.5) 加密随机 AES 密钥。
// 仅依赖 Node 内置 crypto，无第三方依赖。

const crypto = require('crypto');

// 与 Python 版完全一致的固定公钥（PEM，64 字符换行以兼容 OpenSSL 解析）。
const UU_PUBLIC_KEY_PEM = [
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

class UuApiCrypt {
	// aesKey: 16 字符字符串（generateRandomString(16) 生成 → 16 字节 → AES-128）
	constructor(aesKey) {
		this.aesKey = Buffer.from(String(aesKey), 'utf8');
		if (this.aesKey.length !== 16) {
			throw new Error('UU AES key 必须为 16 字节，当前为 ' + this.aesKey.length);
		}
	}

	// 用固定 RSA 公钥(PKCS1 v1.5)加密 AES 密钥，返回 base64
	getEncryptedAesKey() {
		const encrypted = crypto.publicEncrypt(
			{key: UU_PUBLIC_KEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING},
			this.aesKey
		);
		return encrypted.toString('base64');
	}

	// AES-128-ECB + PKCS7 加密明文字符串，返回 base64
	encrypt(content) {
		const cipher = crypto.createCipheriv('aes-128-ecb', this.aesKey, null);
		cipher.setAutoPadding(true); // PKCS7
		const encrypted = Buffer.concat([cipher.update(String(content), 'utf8'), cipher.final()]);
		return encrypted.toString('base64');
	}

	// 解密 base64 密文，返回明文字符串
	decrypt(encryptedBase64) {
		const decipher = crypto.createDecipheriv('aes-128-ecb', this.aesKey, null);
		decipher.setAutoPadding(true); // PKCS7
		const decrypted = Buffer.concat([
			decipher.update(Buffer.from(String(encryptedBase64), 'base64')),
			decipher.final()
		]);
		return decrypted.toString('utf8');
	}
}

module.exports = {UuApiCrypt, UU_PUBLIC_KEY_PEM};
