// 全局轻提示,给不在组件里的代码(stores)用,比如后台任务结束时提醒一下。组件里照常用 useMessage()。

import {createDiscreteApi, darkTheme} from 'naive-ui';
import {themeOverrides} from '../theme.ts';

const {message} = createDiscreteApi(['message'], {
	configProviderProps: {theme: darkTheme, themeOverrides},
	messageProviderProps: {placement: 'top-right'}
});

export const notify = message;
