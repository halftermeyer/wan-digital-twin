// Flow layer (Intent -> OperationalPath -> Validation -> Compliance) constraints
// Additive to 01_constraints.cypher — does not touch the core WAN schema (§3 of prompts/main.md)
CREATE CONSTRAINT intentgroup_id IF NOT EXISTS FOR (n:IntentGroup) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT intent_id IF NOT EXISTS FOR (n:Intent) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT operationalpath_id IF NOT EXISTS FOR (n:OperationalPath) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT validationresult_id IF NOT EXISTS FOR (n:ValidationResult) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT securityviolation_id IF NOT EXISTS FOR (n:SecurityViolation) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT service_id IF NOT EXISTS FOR (n:Service) REQUIRE n.id IS NODE KEY;
CREATE CONSTRAINT application_id IF NOT EXISTS FOR (n:Application) REQUIRE n.id IS NODE KEY;
