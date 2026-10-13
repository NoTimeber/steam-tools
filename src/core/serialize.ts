// 把 GC protobuf 解出来的对象转成能 JSON 序列化的样子(库存、终端机的 raw 字段给前端排查用,从 app/server.js 移来):
// Long → 十进制字符串,Buffer → {type, hex},Date → ISO,bigint → 字符串,丢掉函数,循环引用标成 '[Circular]'。

function isLongLike(value: object): value is {low: number; high: number; unsigned: boolean; toString(): string} {
	const record = value as Record<string, unknown>;
	return typeof record.low === 'number' && typeof record.high === 'number' && Object.prototype.hasOwnProperty.call(value, 'unsigned');
}

export function serializeForJson(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (value == null) {
		return value;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Buffer.isBuffer(value)) {
		return {type: 'Buffer', hex: value.toString('hex')};
	}
	if (Array.isArray(value)) {
		return value.map(item => serializeForJson(item, seen));
	}
	if (typeof value === 'object') {
		if (seen.has(value)) {
			return '[Circular]';
		}
		if (isLongLike(value)) {
			try {
				return value.toString();
			} catch {
				// 按普通对象处理
			}
		}
		seen.add(value);
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (typeof item !== 'function') {
				output[key] = serializeForJson(item, seen);
			}
		}
		seen.delete(value);
		return output;
	}
	return String(value);
}
