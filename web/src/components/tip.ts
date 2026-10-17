// 鼠标放上去显示说明的气泡(Naive 的 NTooltip),给表格里用 h() 渲染的图标按钮、标签用。
// 原生 title 要停一秒多才出来、样式也不统一,图标按钮一律用这个。

import {h} from 'vue';
import type {VNode, VNodeChild} from 'vue';
import {NDropdown, NTooltip} from 'naive-ui';
import type {DropdownProps, PopoverPlacement} from 'naive-ui';

export function withTip(trigger: VNode, tip: VNodeChild | (() => VNodeChild), placement: PopoverPlacement = 'top'): VNode {
	return h(NTooltip, {placement}, {trigger: () => trigger, default: typeof tip === 'function' ? tip : () => tip});
}

/** 点开是下拉菜单、鼠标放上去是说明:下拉挂在外面一层 span 上,气泡挂在按钮上,两个互不干扰 */
export function dropdownWithTip(dropdown: DropdownProps & {onSelect?: (key: never) => void}, trigger: VNode, tip: VNodeChild): VNode {
	return h(NDropdown, {trigger: 'click', ...dropdown}, () => h('span', {class: 'tip-anchor'}, [withTip(trigger, tip)]));
}
