MATCH (r:ResourceObservation)-[:IN_PROJECT]->(po:ProjectObservation {id:$projectObservationId})
MATCH (r)-[:HAS_REFERENCE]->(ref:ConfigurationReference)
RETURN count(ref) AS referenceCount,
 count(CASE WHEN ref.resolution='unresolved' THEN ref END) AS unresolvedCount
