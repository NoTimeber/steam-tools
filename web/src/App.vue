<script setup lang="ts">
import {darkTheme, dateZhCN, NConfigProvider, NDialogProvider, NMessageProvider, zhCN} from 'naive-ui';
import AppShell from './layout/AppShell.vue';
import {themeOverrides} from './theme.ts';
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
