// 全局轻提示,给不在组件里的代码(stores)用,比如后台任务结束时提醒一下。组件里照常用 useMessage()。

import {computed} from 'vue';
import {createDiscreteApi} from 'naive-ui';
import {naiveTheme, themeOverrides} from '../theme.ts';

const {message} = createDiscreteApi(['message'], {
	configProviderProps: computed(() => ({theme: naiveTheme.value, themeOverrides: themeOverrides.value})),
	messageProviderProps: {placement: 'top-right'}
});

export const notify = message;
