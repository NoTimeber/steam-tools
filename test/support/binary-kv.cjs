'use strict';
// 测试用的 BinaryKV 编码器(binarykvparser 只能解析):对象 → 嵌套节点,字符串 → String,
// bigint → UInt64,其它数字 → Int32。用来构造 Steam 推来的 MicroTxn 授权请求等消息体。

const TYPE_NONE = 0;
const TYPE_STRING = 1;
const TYPE_INT32 = 2;
const TYPE_UINT64 = 7;
const TYPE_END = 8;

function cstring(text) {
	return Buffer.concat([Buffer.from(String(text), 'utf8'), Buffer.from([0])]);
}

function encodeBinaryKv(object) {
	const parts = [];
	for (const [name, value] of Object.entries(object)) {
		if (typeof value === 'bigint') {
			const number = Buffer.alloc(8);
			number.writeBigUInt64LE(value);
			parts.push(Buffer.from([TYPE_UINT64]), cstring(name), number);
		} else if (typeof value === 'number') {
			const number = Buffer.alloc(4);
			number.writeInt32LE(value);
			parts.push(Buffer.from([TYPE_INT32]), cstring(name), number);
		} else if (value && typeof value === 'object') {
			parts.push(Buffer.from([TYPE_NONE]), cstring(name), encodeBinaryKv(value));
		} else {
			parts.push(Buffer.from([TYPE_STRING]), cstring(name), cstring(value == null ? '' : value));
		}
	}
	parts.push(Buffer.from([TYPE_END]));
	return Buffer.concat(parts);
}

/** ClientMicroTxnAuthRequest 的消息体:1 字节前缀 + {MessageObject: {...}} */
function microTxnAuthRequestBody({orderId, transId, appId, billingTotal = 0}) {
	return Buffer.concat([
		Buffer.from([1]),
		encodeBinaryKv({MessageObject: {orderid: BigInt(orderId), transid: BigInt(transId), appid: Number(appId), BillingTotal: Number(billingTotal)}})
	]);
}

module.exports = {encodeBinaryKv, microTxnAuthRequestBody};
