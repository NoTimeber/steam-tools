<script setup lang="ts">
// 日期范围选择:只显示一个月的日历,第一下点开始日、第二下点结束日(先点晚的也行),点完就关。
// 只点了开始日就关掉的,原来的范围不变。外观跟 Naive UI 的小号输入框一致。
import {computed, ref, watch} from 'vue';
import {NPopover, useThemeVars} from 'naive-ui';
import {isoDate, monthDays, monthOf, orderedRange, shiftMonth} from '../../lib/calendar.ts';
import type {YearMonth} from '../../lib/calendar.ts';

/** [开始, 结束](YYYY-MM-DD,含两端);null 不限 */
const range = defineModel<[string, string] | null>({required: true});

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const theme = useThemeVars();
const themeStyle = computed(() => ({
	'--input-color': theme.value.inputColor,
	'--input-height': theme.value.heightSmall,
	'--input-font-size': theme.value.fontSizeSmall,
	'--input-radius': theme.value.borderRadius,
	'--input-text': theme.value.textColor2,
	'--input-placeholder': theme.value.placeholderColor,
	'--input-hover': theme.value.primaryColorHover,
	'--input-focus': theme.value.primaryColor
}));

const open = ref(false);
/** 日历显示的月份 */
const shownMonth = ref<YearMonth>({year: 2000, month: 0});
/** 已点的开始日,等点结束日 */
const start = ref<string | null>(null);
/** 选到一半时鼠标所在的日子,用来预览范围 */
const hover = ref<string | null>(null);
const today = ref('');

// 打开时翻到已选范围的结束月(没选就是这个月);开关都清掉选到一半的
watch(open, value => {
	start.value = null;
	hover.value = null;
	if (value) {
		const now = new Date();
		today.value = isoDate(now);
		shownMonth.value = monthOf(range.value?.[1], {year: now.getFullYear(), month: now.getMonth()});
	}
});

const days = computed(() => monthDays(shownMonth.value));
/** 高亮的范围:选到一半时是开始日到鼠标所在的日子,否则是当前值 */
const marked = computed(() => (start.value ? orderedRange(start.value, hover.value ?? start.value) : range.value));

function dayClass(date: string, inMonth: boolean): Record<string, boolean> {
	const [from, to] = marked.value ?? ['', ''];
	return {
		outside: !inMonth,
		today: date === today.value,
		edge: date === from || date === to,
		between: date > from && date < to
	};
}

function pick(date: string): void {
	if (!start.value) {
		start.value = date;
		return;
	}
	range.value = orderedRange(start.value, date);
	open.value = false;
}

function clear(): void {
	range.value = null;
	open.value = false;
}

function turn(delta: number): void {
	shownMonth.value = shiftMonth(shownMonth.value, delta);
}
</script>

<template>
	<NPopover v-model:show="open" trigger="click" placement="bottom-start" :show-arrow="false">
		<template #trigger>
			<button type="button" class="range-input" :class="{open}" :style="themeStyle">
				<span v-if="range" class="mono">{{ range[0] }} 至 {{ range[1] }}</span>
				<span v-else class="placeholder">选择日期范围</span>
				<span v-if="range" class="clear" role="button" aria-label="清除日期范围" title="清除" @click.stop="clear">×</span>
			</button>
		</template>

		<div class="calendar" @mouseleave="hover = null">
			<div class="head">
				<button type="button" class="nav" title="上一年" @click="turn(-12)">«</button>
				<button type="button" class="nav" title="上个月" @click="turn(-1)">‹</button>
				<span class="title">{{ shownMonth.year }} 年 {{ shownMonth.month + 1 }} 月</span>
				<button type="button" class="nav" title="下个月" @click="turn(1)">›</button>
				<button type="button" class="nav" title="下一年" @click="turn(12)">»</button>
			</div>
			<div class="grid">
				<span v-for="weekday in WEEKDAYS" :key="weekday" class="weekday muted">{{ weekday }}</span>
				<button
					v-for="day in days"
					:key="day.date"
					type="button"
					class="day"
					:class="dayClass(day.date, day.inMonth)"
					:title="day.date"
					@click="pick(day.date)"
					@mouseenter="hover = day.date"
				>
					{{ day.day }}
				</button>
			</div>
			<div class="hint muted">{{ start ? `开始 ${start},再点结束日期` : '先点开始日期,再点结束日期' }}</div>
		</div>
	</NPopover>
</template>

<style scoped>
.range-input {
	display: inline-flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 240px;
	height: var(--input-height);
	padding: 0 10px;
	border: 1px solid transparent;
	border-radius: var(--input-radius);
	background: var(--input-color);
	color: var(--input-text);
	font: inherit;
	font-size: var(--input-font-size);
	text-align: left;
	cursor: pointer;
	transition: border-color 0.2s;
}

.range-input:hover {
	border-color: var(--input-hover);
}

.range-input.open,
.range-input:focus-visible {
	border-color: var(--input-focus);
	outline: none;
}

.placeholder {
	color: var(--input-placeholder);
}

.clear {
	color: var(--muted);
	font-size: 16px;
	line-height: 1;
}

.clear:hover {
	color: var(--text);
}

.calendar {
	width: 252px;
	user-select: none;
}

.head {
	display: flex;
	align-items: center;
	gap: 2px;
	margin-bottom: 6px;
}

.title {
	flex: 1;
	text-align: center;
	font-weight: 600;
}

.nav {
	width: 26px;
	height: 26px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: none;
	color: var(--muted);
	font: inherit;
	font-size: 16px;
	cursor: pointer;
}

.nav:hover {
	background: var(--line-soft);
	color: var(--text);
}

.grid {
	display: grid;
	grid-template-columns: repeat(7, 1fr);
	row-gap: 2px;
}

.weekday {
	padding: 4px 0;
	font-size: 12px;
	text-align: center;
}

.day {
	height: 30px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: none;
	color: var(--text);
	font: inherit;
	font-size: 13px;
	cursor: pointer;
}

.day:hover {
	background: var(--line);
}

.day.outside {
	color: var(--muted);
	opacity: 0.55;
}

.day.today {
	box-shadow: inset 0 0 0 1px var(--accent);
}

.day.between {
	border-radius: 0;
	background: rgba(76, 159, 255, 0.18);
}

.day.edge {
	background: var(--accent);
	color: #fff;
	opacity: 1;
}

.hint {
	margin-top: 6px;
	font-size: 12px;
}
</style>
