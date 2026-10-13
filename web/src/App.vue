<script setup lang="ts">
import {darkTheme, dateZhCN, NConfigProvider, NDialogProvider, NMessageProvider, zhCN} from 'naive-ui';
import type {GlobalThemeOverrides} from 'naive-ui';
import AppShell from './layout/AppShell.vue';

// 深色主题,配色沿用旧版界面
const themeOverrides: GlobalThemeOverrides = {
	common: {
		primaryColor: '#4c9fff',
		primaryColorHover: '#74b4ff',
		primaryColorPressed: '#3a8be6',
		primaryColorSuppl: '#4c9fff',
		successColor: '#5ec98a',
		warningColor: '#f2c15d',
		errorColor: '#ff6b6b',
		bodyColor: '#0d0f13',
		cardColor: '#171c23',
		modalColor: '#1e242d',
		popoverColor: '#1e242d',
		tableColor: '#171c23',
		borderColor: '#2f3946',
		dividerColor: '#232c36',
		borderRadius: '6px'
	},
	DataTable: {
		thColor: '#1e242d',
		tdColorHover: '#1e242d'
	}
};
</script>

<template>
	<NConfigProvider abstract :theme="darkTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
		<NMessageProvider placement="top-right">
			<NDialogProvider>
				<AppShell />
			</NDialogProvider>
		</NMessageProvider>
	</NConfigProvider>
</template>
