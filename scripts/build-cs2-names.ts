// 重新生成随包的饰品中英文名词库 app/data/cs2-names-zh.json.gz(说明见 src/items/names.ts)。
// CS2 出了新箱子 / 新印花后跑一次:npm run build:names。要能连上 raw.githubusercontent.com,下载约 90MB。

import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {buildNameMap, NAME_SOURCES, nameSourceUrl} from '../src/items/names.ts';

const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'data', 'cs2-names-zh.json.gz');

const lists = await Promise.all(NAME_SOURCES.map(async file => {
	const res = await fetch(nameSourceUrl(file), {headers: {'User-Agent': 'steam-tools'}, signal: AbortSignal.timeout(180_000)});
	if (!res.ok) {
		throw new Error(`${file}.json HTTP ${res.status}`);
	}
	const list = await res.json();
	console.log(`${file}.json ${Array.isArray(list) ? list.length : 0} 条`);
	return list;
}));

const names = buildNameMap(lists);
const sorted = Object.fromEntries(Object.entries(names).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(OUT_FILE, gzipSync(JSON.stringify({generatedAt: new Date().toISOString(), names: sorted}), {level: 9}));
console.log(`已写入 ${OUT_FILE}:${Object.keys(sorted).length} 个饰品`);
