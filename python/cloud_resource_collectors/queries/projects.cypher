MATCH (s:Snapshot {state:'complete'})-[:HAS_PROJECT]->(po:ProjectObservation)-[:OF_PROJECT]->(p:Project)
WHERE ($cloud IS NULL OR p.cloud=$cloud)
CALL { WITH po MATCH (r:ResourceObservation)-[:IN_PROJECT]->(po) RETURN count(r) AS resourceCount }
CALL { WITH po MATCH (c:Collection)-[:IN_PROJECT]->(po)
 RETURN count(c) AS collectionCount,
 count(CASE WHEN c.status<>'collected' OR NOT c.paginationComplete THEN c END) AS incompleteCollections,
 count(CASE WHEN c.permissionCoverage<>'verified' THEN c END) AS unverifiedCollections }
RETURN p.scopeId AS project, p.accountId AS accountId, p.cloud AS cloud,
 s.snapshotId AS snapshotId, s.finishedAt AS collectedTo, s.origin AS origin,
 po.id AS projectObservationId, po.selectorJson AS selectorJson,
 resourceCount, collectionCount, incompleteCollections, unverifiedCollections
ORDER BY collectedTo DESC, snapshotId DESC, project
LIMIT $limit
