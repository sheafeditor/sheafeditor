# Lease renewal

Renew a lease before it expires. The *gateway* rejects late renewals.

- Check the expiry
- Call `renew`

| Field | Type |
| --- | --- |
| id | string |
| expiry | timestamp |

```js
await lease.renew();
```
