import {createApp} from 'vue';
import App from './App.vue';
import {socket} from './api/socket.ts';
import {router} from './router.ts';
import {startAccounts} from './stores/accounts.ts';
import {startBuyGame} from './stores/buygame.ts';
import {startMarket} from './stores/market.ts';
import {startPurchase} from './stores/purchase.ts';
import {loadUpdateStatus} from './stores/update.ts';
import './styles.css';

createApp(App).use(router).mount('#app');

socket.connect();
startAccounts();
startPurchase();
startBuyGame();
startMarket();
loadUpdateStatus();
