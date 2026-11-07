MATCH (s:Snapshot {state:'complete'})-[:HAS_PROJECT]->(po:ProjectObservation)-[:OF_PROJECT]->(p:Project)
WHERE (p.scopeId=$project OR p.accountId=$project)
 AND ($cloud IS NULL OR p.cloud=$cloud)
 AND ($snapshot IS NULL OR s.snapshotId=$snapshot)
 AND ($origin IS NULL OR s.origin=$origin)
RETURN p.scopeId AS project, p.accountId AS accountId, p.cloud AS cloud,
 s.snapshotId AS snapshotId, s.finishedAt AS collectedTo, s.origin AS origin,
 po.id AS projectObservationId, po.selectorJson AS selectorJson, po.selectorHash AS selectorHash,
 s.limitations AS limitations
ORDER BY collectedTo DESC, snapshotId DESC
