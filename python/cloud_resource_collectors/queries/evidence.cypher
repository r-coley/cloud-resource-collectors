MATCH (s:Snapshot {snapshotId:$snapshot, state:'complete'})-[:HAS_EVIDENCE]->(e:Evidence {localId:$evidenceId})
MATCH (e)-[:FROM_COLLECTION]->(c:Collection)
RETURN s.snapshotId AS snapshotId, e.localId AS id, e.observedAt AS observedAt,
 e.redaction AS redaction, e.recordJson AS recordJson, c.source AS source,
 c.status AS collectionStatus, c.permissionCoverage AS permissionCoverage
