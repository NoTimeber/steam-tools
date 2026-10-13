/*
 * cs2-gc-capture-game.js — 钩 cs2.exe 的 steam_api ISteamGameCoordinator::SendMessage,抓解封 GC 消息。
 *
 * 为什么可靠:这是「已知函数」——ISteamGameCoordinator::SendMessage(msgType, data, len),
 *   钩 vtable[0] 即可,不用猜、不用 arg 扫描、没有假阳性。游戏走 flat 还是 C++ 接口都会经过它。
 *
 * ⚠⚠ VAC 风险:本脚本注入【游戏进程 cs2.exe】。请务必:
 *   1) 只在【主菜单/库存】里抓,【不要在 VAC 对局中】;
 *   2) 抓完立刻 q 回车退出 Frida,并【重启一次 CS2】再去打任何 VAC 匹配;
 *   3) 你已知情并自行承担封号风险。
 *
 * 用法(CS2 已启动、停在主菜单):
 *   frida -n cs2.exe --runtime=v8 -l cs2-gc-capture-game.js
 */

'use strict';

const PROTO_MASK = 0x80000000;
let hooked = false;

function ts() { const d = new Date(); return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
function dump(tag, msgType, dataPtr, len) {
	const masked = (msgType & ~PROTO_MASK) >>> 0;
	console.log(`\n================= [${ts()}] GC ${tag}  msgType=${masked}  proto=${(msgType & PROTO_MASK) !== 0}  len=${len} =================`);
	if (!dataPtr.isNull() && len > 0) console.log(hexdump(dataPtr, {length: Math.min(len, 4096), header: false, ansi: false}));
	console.log('==================================================================');
}

function getModule(name) { const l = String(name).toLowerCase(); try { return Process.enumerateModules().find(m => m.name.toLowerCase() === l) || null; } catch (e) { return null; } }
function findExport(mod, name) {
	const m = getModule(mod); if (!m) return null;
	if (typeof m.findExportByName === 'function') { const p = m.findExportByName(name); if (p) return p; }
	if (typeof m.getExportByName === 'function') { try { const p = m.getExportByName(name); if (p) return p; } catch (e) {} }
	if (typeof Module.findExportByName === 'function') { try { const p = Module.findExportByName(mod, name); if (p) return p; } catch (e) {} }
	return null;
}

// SendMessage(this/self, uint32 unMsgType, const void* pubData, uint32 cubData)
function hookSend(p, via) {
	if (hooked) return true;
	try {
		Interceptor.attach(p, { onEnter(args) { dump('Send(' + via + ')', args[1].toUInt32(), args[2], args[3].toUInt32()); } });
		hooked = true;
		console.log('[+] hooked ISteamGameCoordinator::SendMessage @ ' + p + '  (' + via + ')');
		return true;
	} catch (e) { console.log('  hookSend err: ' + e); return false; }
}

// 主:通过 accessor 拿接口指针 -> 钩 vtable[0](=SendMessage)。flat 包装也会经过它。
function tryAccessor() {
	for (const m of ['steam_api64.dll', 'steam_api.dll']) {
		for (const acc of ['SteamAPI_SteamGameCoordinator_v001', 'SteamAPI_SteamGameCoordinator']) {
			const e = findExport(m, acc);
			if (!e) continue;
			try {
				const iface = (new NativeFunction(e, 'pointer', []))();
				if (iface && !iface.isNull()) {
					const vt = iface.readPointer();
					console.log(`[*] ${acc}() => iface ${iface}  vtable ${vt}`);
					if (hookSend(vt.readPointer(), 'vtable[0] via ' + acc)) return;
				}
			} catch (err) { console.log('  ' + acc + ' err: ' + err); }
		}
	}
}

// 兜底1:钩 SteamInternal_* 接口解析,抓 "SteamGameCoordinator" 返回的接口 -> vtable[0]。
function tryInternal() {
	for (const m of ['steam_api64.dll', 'steam_api.dll']) {
		for (const fname of ['SteamInternal_FindOrCreateUserInterface', 'SteamInternal_CreateInterface', 'SteamInternal_FindOrCreateGameServerInterface']) {
			const e = findExport(m, fname);
			if (!e) continue;
			Interceptor.attach(e, {
				onEnter(args) { try { this.v = (fname.indexOf('FindOrCreate') >= 0 ? args[1] : args[0]).readUtf8String(); } catch (x) { this.v = null; } },
				onLeave(ret) {
					if (this.v && /GameCoordinator/i.test(this.v) && !ret.isNull()) {
						console.log('[*] ' + fname + '("' + this.v + '") => ' + ret);
						try { hookSend(ret.readPointer().readPointer(), 'internal ' + this.v); } catch (x) {}
					}
				}
			});
			console.log('[+] watching ' + m + '!' + fname);
		}
	}
}

// 兜底2:flat 导出(若存在)。
function tryFlat() {
	for (const m of ['steam_api64.dll', 'steam_api.dll']) {
		const e = findExport(m, 'SteamAPI_ISteamGameCoordinator_SendMessage');
		if (e) hookSend(e, 'flat ' + m);
	}
}

setImmediate(function () {
	console.log('[*] cs2-gc-capture-game 启动(注入 cs2.exe)。steam 相关模块:');
	try { Process.enumerateModules().filter(m => /steam/i.test(m.name)).forEach(m => console.log('    ' + m.name + '  ' + m.base)); } catch (e) {}
	tryAccessor();
	if (!hooked) tryInternal();
	if (!hooked) tryFlat();
	if (hooked) console.log('[✓] 钩好了。去库存点【解封】一个终端机,看下面的 GC Send。抓到就 q 退出并重启 CS2。');
	else console.log('[!] 没能直接钩到 SendMessage。把上面的模块列表发我(尤其有没有 steam_api64.dll),我调整。');
});
