/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** 1 = 显示「ECO扫货」(默认隐藏;本机在 web/.env.local 里设,不入库、不进镜像) */
	readonly VITE_FEATURE_ECO?: string;
}

declare module '*.vue' {
	import type {DefineComponent} from 'vue';
	const component: DefineComponent<object, object, any>;
	export default component;
}
