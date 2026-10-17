// 导出 CSV 的小工具(不依赖 Vue):单元格转义、拼成 Excel 能直接打开的文件、让浏览器下载。

export function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 文字列:= + - @ 开头的前面加 ',免得 Excel 当公式执行 */
export function textCell(text: string): string {
	return csvCell(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

/** 带 BOM(Excel 直接打开中文不乱码),CRLF 换行 */
export function csvDocument(lines: readonly string[]): string {
	return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}

/** 让浏览器下载这段 CSV(只在页面里调) */
export function downloadCsv(fileName: string, content: string): void {
	const url = URL.createObjectURL(new Blob([content], {type: 'text/csv;charset=utf-8'}));
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
