MATCH (po:ProjectObservation {id:$projectObservationId})<-[:IN_PROJECT]-(r:ResourceObservation)<-[:HAS_MEMBER]-(service:ServiceObservation)
WITH DISTINCT service
MATCH (service)-[:HAS_GAP]->(gap:Gap)
RETURN service.serviceId AS serviceId, gap.code AS code, gap.message AS message
ORDER BY serviceId, code LIMIT $limit
