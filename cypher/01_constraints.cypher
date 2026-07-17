// Node key constraints — created before any data load
CREATE CONSTRAINT city_code IF NOT EXISTS FOR (c:City) REQUIRE c.code IS NODE KEY;
CREATE CONSTRAINT router_hostname IF NOT EXISTS FOR (r:Router) REQUIRE r.hostname IS NODE KEY;
CREATE CONSTRAINT interface_id IF NOT EXISTS FOR (i:Interface) REQUIRE i.id IS NODE KEY;
CREATE CONSTRAINT provider_name IF NOT EXISTS FOR (p:Provider) REQUIRE p.name IS NODE KEY;
CREATE CONSTRAINT incident_id IF NOT EXISTS FOR (i:Incident) REQUIRE i.id IS NODE KEY;
