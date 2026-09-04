# Persistent center accounts

Center accounts and distributed-code tracking are stored in the JSON ledger configured by `CENTER_LEDGER_PATH`.

For Railway:

1. Open the service in Railway.
2. Add a Volume and mount it at `/app/data`.
3. Add this environment variable:

```text
CENTER_LEDGER_PATH=/app/data/center-recharge-ledger.json
```

4. Deploy/restart the service.

The application creates the ledger file automatically on the mounted volume. Do not rely on the repository copy for runtime account data: deployment filesystems are replaced during deployments.

Existing accounts from the old ephemeral file must be recreated once, or copied into the mounted ledger before the first production use. The database is not modified by this setup.
