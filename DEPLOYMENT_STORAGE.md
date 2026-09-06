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

# Optional call-center integration

The student system can optionally send students from a session report or the
follow-up dashboard directly to the call-center. This is disabled unless all
three variables below are configured on the student-system server:

```text
CALLCENTER_INTEGRATION_ENABLED=true
CALLCENTER_INTERNAL_URL=http://127.0.0.1:4000/api/sessions/internal
CALLCENTER_SERVICE_TOKEN=<long-random-shared-secret>
```

Configure the same `CALLCENTER_SERVICE_TOKEN` in the call-center backend. The
integration uses a server-to-server request; the token is never sent to the
browser. The existing call-center start page, login, manual Excel import,
caller workflow, and exports remain available.

Session-report actions send present or absent students. The follow-up action
sends only rows currently visible after the page search and includes active
dashboard filters in the generated call-session name. A failed handoff does
not replace or disable the existing Excel exports.

To roll back, remove the integration variables or set
`CALLCENTER_INTEGRATION_ENABLED=false` and restart the student server. No
database rollback is required.
