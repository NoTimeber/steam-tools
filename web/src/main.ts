import {createApp} from 'vue';
import App from './App.vue';
import {socket} from './api/socket.ts';
import {router} from './router.ts';
import {startAccounts} from './stores/accounts.ts';
import {startBuyGame} from './stores/buygame.ts';
import {startC5} from './stores/c5.ts';
import {startMarket} from './stores/market.ts';
import {startPurchase} from './stores/purchase.ts';
import {startUpdateStatus} from './stores/update.ts';
import {startUu} from './stores/uu.ts';
import {startWallet} from './stores/wallet.ts';
import './styles.css';

createApp(App).use(router).mount('#app');

socket.connect();
startAccounts();
startPurchase();
startBuyGame();
startMarket();
startUu();
startC5();
startWallet();
startUpdateStatus();
