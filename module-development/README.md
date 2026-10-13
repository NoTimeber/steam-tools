# Module Development

Last updated: 2026-04-29

This folder records the current development state of each module in `steam-login-replica`.

Current module coverage:

- `account-management.md`: implemented UI and current runtime behavior
- `inventory-management.md`: implemented GC-connected inventory module and current runtime behavior
- `purchase-management.md`: implemented purchase orchestration UI and simulated task worker behavior
- `uu-delivery.md`: implemented UU token-driven delivery module and its account-matching rules

Current top-level module layout:

- `账户管理`: implemented
- `库存管理`: implemented
- `内购任务`: implemented (simulated worker)
- `运行设置`: placeholder

Relevant code entry points:

- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `server.js`
- `package.json`
