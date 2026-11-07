MATCH (c:Collection)-[:IN_PROJECT]->(po:ProjectObservation {id:$projectObservationId})
RETURN c.localId AS id, c.source AS source, c.status AS status,
 c.paginationComplete AS paginationComplete, c.permissionCoverage AS permissionCoverage,
 c.recordCount AS recordCount, c.errorCode AS errorCode
ORDER BY source
