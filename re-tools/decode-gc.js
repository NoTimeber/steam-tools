'use strict';
// 通用 protobuf 解析:把抓到的 GC payload hex 拆成 字段号/类型/值,看结构(尤其找隐藏 bytes token)。
// 用法: node decode-gc.js <hex>     hex 可含空格/换行/0x
const hex = process.argv.slice(2).join('').replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
if (!hex) { console.error('用法: node decode-gc.js <hex>'); process.exit(1); }
const buf = Buffer.from(hex, 'hex');
console.log(`总长 ${buf.length} 字节  hex=${buf.toString('hex')}\n`);

function readVarint(b, o) {
	let shift = 0n, result = 0n, pos = o;
	while (pos < b.length) {
		const byte = b[pos++];
		result |= BigInt(byte & 0x7f) << shift;
		if (!(byte & 0x80)) break;
		shift += 7n;
	}
	return {value: result, next: pos};
}

function walk(b, indent) {
	let o = 0;
	while (o < b.length) {
		const t = readVarint(b, o); o = t.next;
		const field = Number(t.value >> 3n);
		const wire = Number(t.value & 7n);
		if (field === 0) { console.log(indent + '⟨中断:field 0⟩'); return; }
		if (wire === 0) {
			const v = readVarint(b, o); o = v.next;
			console.log(`${indent}#${field} varint = ${v.value}`);
		} else if (wire === 1) {
			if (o + 8 > b.length) { console.log(indent + '⟨fixed64 越界⟩'); return; }
			console.log(`${indent}#${field} fixed64 = ${b.readBigUInt64LE(o)}`); o += 8;
		} else if (wire === 2) {
			const len = readVarint(b, o); o = len.next;
			const L = Number(len.value);
			if (o + L > b.length) { console.log(indent + `⟨bytes 越界 len=${L}⟩`); return; }
			const sub = b.slice(o, o + L); o += L;
			const ascii = sub.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
			console.log(`${indent}#${field} bytes[${L}] hex=${sub.toString('hex')}  ascii="${ascii}"`);
			if (L > 1 && L < 8192) { console.log(indent + '  ↳(尝试当子消息)'); try { walk(sub, indent + '    '); } catch (e) {} }
		} else if (wire === 5) {
			if (o + 4 > b.length) { console.log(indent + '⟨fixed32 越界⟩'); return; }
			console.log(`${indent}#${field} fixed32 = ${b.readUInt32LE(o)}`); o += 4;
		} else {
			console.log(`${indent}⟨未知 wire ${wire},停⟩`); return;
		}
	}
}
walk(buf, '');
