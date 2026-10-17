<script setup lang="ts">
import {dateZhCN, NConfigProvider, NDialogProvider, NMessageProvider, zhCN} from 'naive-ui';
import AppShell from './layout/AppShell.vue';
import {naiveTheme, themeOverrides} from './theme.ts';
</script>

<template>
	<NConfigProvider abstract :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
		<NMessageProvider placement="top-right">
			<NDialogProvider>
				<AppShell />
			</NDialogProvider>
		</NMessageProvider>
	</NConfigProvider>
</template>
