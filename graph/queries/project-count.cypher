MATCH (r:ResourceObservation)-[:IN_PROJECT]->(po:ProjectObservation {id:$projectObservationId})
WHERE ($kind IS NULL OR r.kind=$kind)
RETURN count(r) AS resourceCount
