# Node Single-Replica Cutover

These manifests are a cutover template for the existing `grok2api` namespace.
They are intentionally not wired into the live Argo CD application yet.

1. Let GitHub Actions publish `ghcr.io/prodigalgal/grokcli-2api:node-edge` and
   `ghcr.io/prodigalgal/grokcli-2api:node-migration-edge`.
2. Create `GROK2API_XAI_UPSTREAM_BASE_URL` in `grok2api-secrets`; it must be a
   direct xAI Responses endpoint, never a CPA or other relay endpoint.
3. Stop old registration and maintenance, take a PostgreSQL backup, then apply
   the suspended exporter Job. It reads the in-cluster PostgreSQL Service and
   writes `/app/data-node/migration/snapshot.json` to `grok2api-node-data`.
   The snapshot contains account credentials and must never enter Git or a
   ConfigMap.
4. Unsuspend the importer Job only while the Node Deployment is scaled to zero.
   Compare exporter/importer counts and checksums from their command reports.
5. Run Node with maintenance and registration disabled for the first direct
   xAI Chat/Responses canary. Enable them only after the canary and restart
   recovery test pass.

`grok2api-node-data` is deliberately distinct from the legacy data PVC. Do not
remove the legacy PostgreSQL, Redis, or data volumes during the rollback window.
