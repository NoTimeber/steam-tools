// 「立即更新」按钮:先确认(会重启服务、在线账号会断开),再请求一键更新。顶部提示和运行设置共用。

import {ref} from 'vue';
import {useDialog, useMessage} from 'naive-ui';
import {errorText} from '../api/http.ts';
import {applyUpdate, update} from '../stores/update.ts';

export function useApplyUpdate() {
	const dialog = useDialog();
	const message = useMessage();
	const requesting = ref(false);

	function confirmUpdate(): void {
		const target = update.hasUpdate && update.latest ? ` v${update.latest}` : '最新版';
		dialog.warning({
			title: '立即更新',
			content: `在服务器上拉取新代码和新镜像,把服务重启到${target}(一般 1–3 分钟)。重启时在线的 Steam 账号会断开,启动后按原来的登录状态自动恢复;正在跑的任务会中断。`,
			positiveText: '更新',
			negativeText: '取消',
			onPositiveClick: async () => {
				requesting.value = true;
				try {
					await applyUpdate();
					message.info('已请求更新,进度显示在页面顶部');
				} catch (err) {
					message.error(errorText(err));
				} finally {
					requesting.value = false;
				}
			}
		});
	}

	return {confirmUpdate, requesting};
}
