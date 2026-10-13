'use strict';

/**
 * 生成更新所需的密钥。可重复运行(只补缺失的)。
 *
 *   node tools/keygen.js
 *
 * 产物:
 *   ~/.steam-tools-keys/update-private.pem ← Ed25519 私钥(签名用),放项目目录外。只留你/服务器,绝不分发!
 *                                            可用 UPDATE_KEY_DIR 覆盖目录。
 *   public-key.pem                 ← Ed25519 公钥(验签用)。随客户端分发。
 *   update-key.bin                 ← AES-256 对称密钥(加解密 zip)。随客户端分发。
 *
 * 说明:AES 是对称密钥,客户端必须有它才能解密运行,所以它"不得不"随客户端发 ——
 * 加密只能挡住逛 GitHub 的外人,挡不住能读取客户端磁盘的人(那是混淆的事)。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_DIR = process.env.UPDATE_KEY_DIR ? path.resolve(process.env.UPDATE_KEY_DIR) : path.join(os.homedir(), '.steam-tools-keys');
const PRIV = path.join(KEY_DIR, 'update-private.pem');
const PUB = path.join(ROOT, 'public-key.pem');
const AESKEY = path.join(ROOT, 'update-key.bin');

fs.mkdirSync(KEY_DIR, {recursive: true});

// 1) Ed25519 签名密钥对(两个都缺才生成;只缺一个说明状态异常,提示手动处理)
if (!fs.existsSync(PRIV) && !fs.existsSync(PUB)) {
	const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
	fs.writeFileSync(PRIV, privateKey.export({type: 'pkcs8', format: 'pem'}));
	fs.writeFileSync(PUB, publicKey.export({type: 'spki', format: 'pem'}));
	console.log(`已生成签名密钥对: ${PRIV}(保密) + public-key.pem(分发)`);
} else if (fs.existsSync(PRIV) && fs.existsSync(PUB)) {
	console.log('签名密钥对已存在,跳过。');
} else {
	console.error('⚠ 签名密钥只剩一半(public-key.pem 与 update-private.pem 不成对)。');
	console.error('  请手动删掉残留的那个再重跑,但注意换签名密钥会让老客户端无法验证新更新。');
	process.exit(1);
}

// 2) AES-256 对称密钥(缺则补)
if (!fs.existsSync(AESKEY)) {
	fs.writeFileSync(AESKEY, crypto.randomBytes(32));
	console.log('已生成对称密钥: update-key.bin(随客户端分发,用于解密 zip)');
} else {
	console.log('对称密钥 update-key.bin 已存在,跳过。');
}

console.log(`\n⚠ 私钥目录 ${KEY_DIR} 不要放进项目/发布包;public-key.pem 与 update-key.bin 随客户端发。`);
