// 主题:锌灰 + 琥珀色,浅色 / 深色跟随系统(prefers-color-scheme)。颜色和 styles.css 里的变量保持一致。
// App.vue 和全局提示(api/notify.ts)共用

import {computed, ref} from 'vue';
import {darkTheme} from 'naive-ui';
import type {GlobalThemeOverrides} from 'naive-ui';

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** 系统是不是深色(系统切换时跟着变) */
export const isDark = ref(media ? media.matches : true);
media?.addEventListener('change', event => {
	isDark.value = event.matches;
});

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

const LIGHT: GlobalThemeOverrides = {
	common: {
		fontFamily: FONT,
		primaryColor: '#d97706',
		primaryColorHover: '#f59e0b',
		primaryColorPressed: '#b45309',
		primaryColorSuppl: '#f59e0b',
		infoColor: '#2563eb',
		successColor: '#16a34a',
		warningColor: '#d97706',
		errorColor: '#dc2626',
		bodyColor: '#f4f4f5',
		cardColor: '#ffffff',
		modalColor: '#ffffff',
		popoverColor: '#ffffff',
		tableColor: '#ffffff',
		borderColor: '#e4e4e7',
		dividerColor: '#f0f0f2',
		textColorBase: '#18181b',
		textColor1: '#18181b',
		textColor2: '#3f3f46',
		textColor3: '#71717a',
		borderRadius: '8px'
	},
	Button: {
		textColorPrimary: '#ffffff',
		textColorHoverPrimary: '#ffffff',
		textColorPressedPrimary: '#ffffff',
		textColorFocusPrimary: '#ffffff'
	},
	Card: {borderRadius: '12px'},
	DataTable: {
		thColor: '#fafafa',
		tdColorHover: '#fafafa',
		thFontWeight: '600',
		borderColor: '#f0f0f2',
		borderRadius: '12px'
	},
	Menu: {
		itemTextColorActive: '#b45309',
		itemTextColorActiveHover: '#b45309',
		itemIconColorActive: '#d97706',
		itemIconColorActiveHover: '#d97706',
		itemColorActive: 'rgba(9, 9, 11, 0.05)',
		itemColorActiveHover: 'rgba(9, 9, 11, 0.05)',
		itemColorHover: 'rgba(9, 9, 11, 0.04)',
		itemTextColor: '#3f3f46',
		itemIconColor: '#a1a1aa',
		groupTextColor: '#71717a',
		borderRadius: '8px',
		itemHeight: '36px'
	},
	Tabs: {
		tabTextColorActiveLine: '#b45309',
		tabTextColorHoverLine: '#d97706',
		barColor: '#d97706'
	}
};

const DARK: GlobalThemeOverrides = {
	common: {
		fontFamily: FONT,
		primaryColor: '#f59e0b',
		primaryColorHover: '#fbbf24',
		primaryColorPressed: '#d97706',
		primaryColorSuppl: '#f59e0b',
		infoColor: '#60a5fa',
		successColor: '#4ade80',
		warningColor: '#fbbf24',
		errorColor: '#f87171',
		bodyColor: '#09090b',
		cardColor: '#18181b',
		modalColor: '#1c1c1f',
		popoverColor: '#222225',
		tableColor: '#18181b',
		borderColor: '#2e2e33',
		dividerColor: '#26262a',
		borderRadius: '8px'
	},
	Button: {
		textColorPrimary: '#18181b',
		textColorHoverPrimary: '#18181b',
		textColorPressedPrimary: '#18181b',
		textColorFocusPrimary: '#18181b'
	},
	Card: {borderRadius: '12px'},
	DataTable: {
		thColor: '#1f1f22',
		tdColorHover: '#1f1f22',
		thFontWeight: '600',
		borderColor: '#26262a',
		borderRadius: '12px'
	},
	Menu: {
		itemTextColorActive: '#fbbf24',
		itemTextColorActiveHover: '#fbbf24',
		itemIconColorActive: '#fbbf24',
		itemIconColorActiveHover: '#fbbf24',
		itemColorActive: 'rgba(255, 255, 255, 0.05)',
		itemColorActiveHover: 'rgba(255, 255, 255, 0.05)',
		itemColorHover: 'rgba(255, 255, 255, 0.05)',
		itemTextColor: '#d4d4d8',
		itemIconColor: '#71717a',
		groupTextColor: '#a1a1aa',
		borderRadius: '8px',
		itemHeight: '36px'
	},
	Tabs: {
		tabTextColorActiveLine: '#fbbf24',
		tabTextColorHoverLine: '#fbbf24',
		barColor: '#f59e0b'
	}
};

export const naiveTheme = computed(() => (isDark.value ? darkTheme : null));
export const themeOverrides = computed(() => (isDark.value ? DARK : LIGHT));
