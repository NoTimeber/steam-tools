// 构建产物在 web/dist,由服务端(src/web/app.ts)托管。开发时 `npm run dev`,接口和 socket.io 转给本机服务端。
// 不改 Host 头(changeOrigin: false):服务端按 Origin 与 Host 同域做 CSRF 校验,改了反而对不上。

import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';

const backend = process.env.BACKEND_URL || 'http://127.0.0.1:53110';

export default defineConfig({
	plugins: [vue()],
	// 相对路径:产物不绑死挂载位置(路由用 hash 模式)
	base: './',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		chunkSizeWarningLimit: 1500
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			'/api': {target: backend, changeOrigin: false},
			'/login': {target: backend, changeOrigin: false},
			'/socket.io': {target: backend, changeOrigin: false, ws: true}
		}
	}
});
