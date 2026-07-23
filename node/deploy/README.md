# Node Single-Replica Cutover

These manifests are a cutover template for the existing `grok2api` namespace.
They are intentionally not wired into the live Argo CD application yet.

1. Let GitHub Actions publish `ghcr.io/prodigalgal/grokcli-2api:node-edge`.
2. Create `GROK2API_XAI_UPSTREAM_BASE_URL` in `grok2api-secrets`; it must be a
   direct xAI Responses endpoint, never a CPA or other relay endpoint.
3. Stop old registration and maintenance, take a PostgreSQL backup, then run
   `npm run export:legacy-snapshot -- <snapshot.json>` from a controlled host.
4. Copy the private snapshot to `grok2api-data/node-migration/snapshot.json`.
   It contains account credentials and must never enter Git or a ConfigMap.
5. Apply the manifests with the import Job still suspended. Unsuspend the Job
   only while the Node Deployment is scaled to zero. Compare export/import
   counts and checksums from the two command reports.
6. Run Node with maintenance and registration disabled for the first direct
   xAI Chat/Responses canary. Enable them only after the canary and restart
   recovery test pass.

`grok2api-node-data` is deliberately distinct from the legacy data PVC. Do
not remove the legacy PostgreSQL, Redis, or data volumes during the rollback
window.
