// 复制到剪贴板。不是 HTTPS 时浏览器没有 navigator.clipboard,退回老办法(临时 textarea + execCommand)。

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const input = document.createElement('textarea');
		input.value = text;
		document.body.appendChild(input);
		input.select();
		document.execCommand('copy');
		input.remove();
	}
}
