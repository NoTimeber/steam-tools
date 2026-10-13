// socket.io 推送(和页面同源,握手时浏览器自动带上登录 cookie)。

import {ref} from 'vue';
import {io} from 'socket.io-client';
import {redirectToLogin} from './http.ts';

export const socket = io({autoConnect: false});
export const socketConnected = ref(false);

socket.on('connect', () => {
	socketConnected.value = true;
});
socket.on('disconnect', () => {
	socketConnected.value = false;
});
socket.on('connect_error', err => {
	socketConnected.value = false;
	if (/unauthorized/i.test(err.message || '')) {
		redirectToLogin();
	}
});
