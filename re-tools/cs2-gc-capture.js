/*
 * cs2-gc-capture.js — 用 Frida 钩「Steam 客户端」抓 CS2 GC 明文消息。(Frida 16/17 兼容)
 *
 * 关键:CS2 的 GC 接口不是用字符串 CreateInterface 拿的,而是 IClientEngine::GetIClientGameCoordinator(...)。
 * 本脚本:CreateInterface -> 拿到 IClientEngine -> 钩它整张 vtable -> 凡返回"子接口"的都钩其 SendMessage/Retrieve,
 *         再靠 arg 扫描(找 proto 掩码的 msgType + 紧跟指针 + 合理长度)自动认出 GC 收发,dump 明文。
 *
 * ★ VAC 安全:只钩 steam.exe / steamclient64.dll,【绝不碰 cs2.exe】。仍属 ToS 灰区,自担风险。
 * ⚠ 会钩 IClientEngine 上百个方法,Steam 可能变卡;抓到后尽快退出(q 回车)。
 *
 * 用法(spawn,推荐):frida -f "D:\\steam\\steam.exe" --runtime=v8 -l cs2-gc-capture.js
 */

'use strict';

const PROTO_MASK = 0x80000000;
let SC_BASE = null, SC_END = null;
const seenSub = new Set();     // 已钩过的子接口
const seenIfaces = new Set();  // CreateInterface 去重

function ts() { const d = new Date(); return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0'); }

function getModule(name) {
	const lname = String(name).toLowerCase();
	try { return Process.enumerateModules().find(m => m.name.toLowerCase() === lname) || null; } catch (e) { return null; }
}
function findExport(moduleName, exportName) {
	const m = getModule(moduleName);
	if (m) {
		if (typeof m.findExportByName === 'function') { const p = m.findExportByName(exportName); if (p) return p; }
		if (typeof m.getExportByName === 'function') { try { const p = m.getExportByName(exportName); if (p) return p; } catch (e) {} }
	}
	if (typeof Module.findExportByName === 'function') { try { const p = Module.findExportByName(moduleName, exportName); if (p) return p; } catch (e) {} }
	if (typeof Module.getGlobalExportByName === 'function') { try { const p = Module.getGlobalExportByName(exportName); if (p) return p; } catch (e) {} }
	return null;
}
function computeSCRange() {
	const m = getModule('steamclient64.dll') || getModule('steamclient.dll');
	if (m) { SC_BASE = m.base; SC_END = m.base.add(m.size); }
}
function inSC(p) { try { return SC_BASE && p.compare(SC_BASE) >= 0 && p.compare(SC_END) < 0; } catch (e) { return false; } }
function readable(p) { try { p.readU8(); return true; } catch (e) { return false; } }

// 走前几个字段验证像不像 protobuf(在 len 内干净解出 >=2 个字段)。比只看首字节强得多,能在不依赖 proto 掩码时压住误报。
function looksLikeProtobuf(ptr, len) {
	try {
		let o = 0, fields = 0; const cap = Math.min(len, 96);
		while (o < cap && fields < 4) {
			let shift = 0, b, tag = 0;
			do { b = ptr.add(o).readU8(); tag |= (b & 0x7f) << shift; shift += 7; o++; } while ((b & 0x80) && o < cap && shift < 35);
			const wire = tag & 7, field = tag >>> 3;
			if (field < 1) return false;
			if (wire === 0) { let bb, g = 0; do { bb = ptr.add(o).readU8(); o++; g++; } while ((bb & 0x80) && o < cap && g < 10); }
			else if (wire === 1) o += 8;
			else if (wire === 5) o += 4;
			else if (wire === 2) { let l = 0, s = 0, bb; do { bb = ptr.add(o).readU8(); l |= (bb & 0x7f) << s; s += 7; o++; } while ((bb & 0x80) && o < cap); o += l; }
			else return false; // wire 3/4/6/7 非法
			if (o > len) return false;
			fields++;
		}
		return fields >= 2;
	} catch (e) { return false; }
}

// retval 像不像一个接口指针:其首 qword(vtable)落在 steamclient 内。
function looksLikeInterface(p) {
	try { if (p.isNull()) return false; const vt = p.readPointer(); return inSC(vt); } catch (e) { return false; }
}

function dumpGC(tag, msgType, dataPtr, len) {
	const masked = (msgType & ~PROTO_MASK) >>> 0;
	console.log(`\n================= [${ts()}] GC ${tag}  msgType=${masked}  len=${len} =================`);
	if (!dataPtr.isNull() && len > 0) console.log(hexdump(dataPtr, {length: Math.min(len, 4096), header: false, ansi: false}));
	console.log('==============================================================');
}

// 钩一个候选子接口的前几个 vtable 槽,靠 arg 扫描认 GC send(msgType 带 proto 掩码)。
function hookSubInterface(iface, viaIndex) {
	const key = iface.toString();
	if (seenSub.has(key)) return;
	seenSub.add(key);
	console.log(`    [sub-iface] via IClientEngine#${viaIndex}  ${iface}`);
	let vtbl; try { vtbl = iface.readPointer(); } catch (e) { return; }
	for (let slot = 0; slot < 10; slot++) {
		let fn; try { fn = vtbl.add(slot * Process.pointerSize).readPointer(); } catch (e) { break; }
		if (fn.isNull() || !inSC(fn)) continue;
		try {
			Interceptor.attach(fn, {
				onEnter(args) {
					// 识别 GC send:某参数是"很小的 msg号"(有无 proto 掩码都认)+ 下个是可读指针且能解成 protobuf + 合理长度
					for (let i = 1; i <= 4; i++) {
						let raw; try { raw = args[i].toUInt32(); } catch (e) { continue; }
						const masked = (raw & ~PROTO_MASK) >>> 0;
						if (masked < 1 || masked > 100000) continue;      // 真 GC 消息号都很小(1007/4006/9xxx…)
						const dataArg = args[i + 1];
						let len; try { len = args[i + 2].toUInt32(); } catch (e) { continue; }
						if (len < 1 || len > 0x40000) continue;
						if (!looksLikeProtobuf(dataArg, len)) continue;   // 真解一层 protobuf,压误报
						dumpGC(`Send  (IClientEngine#${viaIndex}, slot=${slot}, argpos=${i})`, raw, dataArg, len);
						return;
					}
				}
			});
		} catch (e) {}
	}
}

// 钩 IClientEngine 整张 vtable:凡方法返回"子接口"就钩它找 GC。
function hookClientEngine(iface) {
	let vtbl; try { vtbl = iface.readPointer(); } catch (e) { return; }
	let count = 0;
	for (let i = 0; i < 800; i++) {
		let fn; try { fn = vtbl.add(i * Process.pointerSize).readPointer(); } catch (e) { break; }
		if (fn.isNull() || !inSC(fn)) break; // vtable 结束
		try {
			Interceptor.attach(fn, { onLeave(retval) { try { if (looksLikeInterface(retval)) hookSubInterface(retval, i); } catch (e) {} } });
			count++;
		} catch (e) {}
	}
	console.log(`[+] IClientEngine: 钩了 ${count} 个 vtable 方法。现在启动 CS2 -> 进库存 -> 点解封。`);
	console.log('    (Steam 可能变卡,正常。抓到 "GC Send" 那段 hex 就发出来,然后 q 回车退出。)');
}

function tryHookCreateInterface() {
	const mod = getModule('steamclient64.dll') || getModule('steamclient.dll');
	if (!mod) return false;
	computeSCRange();
	const ci = findExport(mod.name, 'CreateInterface');
	if (!ci) { console.log('[!] steamclient 未找到 CreateInterface 导出'); return true; }
	Interceptor.attach(ci, {
		onEnter(args) { try { this.name = args[0].readUtf8String(); } catch (e) { this.name = null; } },
		onLeave(retval) {
			if (!this.name || retval.isNull()) return;
			if (!seenIfaces.has(this.name)) { seenIfaces.add(this.name); console.log(`    [iface] ${this.name} => ${retval}`); }
			if (/ClientEngine/i.test(this.name)) { console.log(`[*] ★ 拿到 IClientEngine (${this.name}),开始钩它的 vtable…`); try { hookClientEngine(retval); } catch (e) { console.log('  err: ' + e); } }
			if (/GameCoordinator/i.test(this.name)) { try { hookSubInterface(retval, -1); } catch (e) {} }
		}
	});
	console.log(`[+] hooked ${mod.name}!CreateInterface —— 等 IClientEngine 出现…(spawn 模式下 Steam 启动时就会有)`);
	return true;
}

setImmediate(function () {
	console.log('[*] cs2-gc-capture 启动。steam 相关模块:');
	try { Process.enumerateModules().filter(m => /steam/i.test(m.name)).forEach(m => console.log('    ' + m.name + '  ' + m.base)); } catch (e) {}
	if (!tryHookCreateInterface()) {
		console.log('[!] steamclient64.dll 还没加载,轮询等待…');
		const t = setInterval(function () { if (tryHookCreateInterface()) clearInterval(t); }, 500);
	}
});
